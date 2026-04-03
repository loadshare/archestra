import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SharePointConnector } from "./sharepoint-connector";

const credentials = { email: "test-client-id", apiToken: "test-client-secret" };

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ access_token: "test-access-token" }),
  } as unknown as Response;
}

function makeSiteResponse(siteId = "site-123") {
  return {
    ok: true,
    json: async () => ({ id: siteId }),
  } as unknown as Response;
}

function makeDriveListResponse(driveIds: string[] = ["drive-1"]) {
  return {
    ok: true,
    json: async () => ({
      value: driveIds.map((id) => ({ id })),
    }),
  } as unknown as Response;
}

function makeDriveItem(
  id: string,
  name: string,
  opts?: { lastModified?: string; size?: number; webUrl?: string },
) {
  return {
    id,
    name,
    webUrl: opts?.webUrl ?? `https://tenant.sharepoint.com/sites/test/${name}`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    size: opts?.size ?? 1024,
    file: { mimeType: "text/plain" },
    parentReference: { path: "/drives/drive-1/root:" },
  };
}

function makeDriveItemsResponse(
  items: ReturnType<typeof makeDriveItem>[],
  opts?: { nextLink?: string },
) {
  return {
    ok: true,
    json: async () => ({
      value: items,
      "@odata.nextLink": opts?.nextLink ?? undefined,
    }),
  } as unknown as Response;
}

function makeSitePage(
  id: string,
  title: string,
  opts?: { lastModified?: string },
) {
  return {
    id,
    name: `${title.toLowerCase().replace(/\s/g, "-")}.aspx`,
    title,
    webUrl: `https://tenant.sharepoint.com/sites/test/SitePages/${title}.aspx`,
    lastModifiedDateTime: opts?.lastModified ?? "2024-01-15T10:00:00.000Z",
    createdDateTime: "2024-01-01T00:00:00.000Z",
    description: `Description for ${title}`,
  };
}

function makeSitePagesResponse(
  pages: ReturnType<typeof makeSitePage>[],
  opts?: { nextLink?: string },
) {
  return {
    ok: true,
    json: async () => ({
      value: pages,
      "@odata.nextLink": opts?.nextLink ?? undefined,
    }),
  } as unknown as Response;
}

function makeFileContentResponse(text: string) {
  return {
    ok: true,
    text: async () => text,
  } as unknown as Response;
}

function makeWebPartsResponse(webParts: Array<{ innerHtml?: string }> = []) {
  return {
    ok: true,
    json: async () => ({ value: webParts }),
  } as unknown as Response;
}

function spyFetch(connector: SharePointConnector) {
  return vi.spyOn(
    connector as unknown as {
      fetchWithRetry: (...args: unknown[]) => unknown;
    },
    "fetchWithRetry",
  );
}

describe("SharePointConnector", () => {
  it("has the correct type", () => {
    const connector = new SharePointConnector();
    expect(connector.type).toBe("sharepoint");
  });

  describe("validateConfig", () => {
    it("accepts valid config with siteUrl", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
        siteUrl: "https://tenant.sharepoint.com/sites/test",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with optional driveIds and folderPath", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({
        tenantId: "test-tenant-id",
        siteUrl: "https://tenant.sharepoint.com/sites/test",
        driveIds: ["drive-1"],
        folderPath: "Documents/Engineering",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config without siteUrl", async () => {
      const connector = new SharePointConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    it("returns success when site resolves", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce(makeSiteResponse());

      const result = await connector.testConnection({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
      });

      expect(result.success).toBe(true);
    });

    it("returns failure when site cannot be resolved", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse());
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not found",
      } as unknown as Response);

      const result = await connector.testConnection({
        config: {
          siteUrl: "https://tenant.sharepoint.com/sites/nonexistent",
        },
        credentials,
      });

      expect(result.success).toBe(false);
    });

    it("returns failure when token request fails", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid client",
      } as unknown as Response);

      const result = await connector.testConnection({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("OAuth token request failed");
    });
  });

  describe("sync — drive items", () => {
    it("syncs text files from drive", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([
          makeDriveItem("item-1", "readme.md"),
          makeDriveItem("item-2", "notes.txt"),
        ]),
      );
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("# Hello World"));
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Some notes"));
      // Site pages
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Drive batch + site pages batch
      expect(batches.length).toBeGreaterThanOrEqual(1);
      const driveBatch = batches[0];
      expect(driveBatch.documents).toHaveLength(2);
      expect(driveBatch.documents[0].title).toBe("readme.md");
      expect(driveBatch.documents[0].content).toContain("# Hello World");
      expect(driveBatch.documents[1].title).toBe("notes.txt");
    });

    it("skips unsupported file types", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([
          makeDriveItem("item-1", "doc.txt"),
          {
            ...makeDriveItem("item-2", "photo.jpg"),
            file: { mimeType: "image/jpeg" },
          },
          {
            ...makeDriveItem("item-3", "spreadsheet.xlsx"),
            file: { mimeType: "application/vnd.openxmlformats" },
          },
        ]),
      );
      // Only doc.txt gets content downloaded
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Text content"));
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only .txt file passes the filter
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("doc.txt");
    });

    it("paginates drive items using @odata.nextLink", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      // First page
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([makeDriveItem("item-1", "file1.txt")], {
          nextLink:
            "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=abc",
        }),
      );
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Content 1"));
      // Second page
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([makeDriveItem("item-2", "file2.txt")]),
      );
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Content 2"));
      // Site pages
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // 2 drive batches + 1 site pages batch
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches[0].documents[0].title).toBe("file1.txt");
      expect(batches[1].documents[0].title).toBe("file2.txt");
    });

    it("uses incremental filter when checkpoint exists", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      fetchMock.mockResolvedValueOnce(makeDriveItemsResponse([]));
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      for await (const _ of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: {
          type: "sharepoint",
          lastSyncedAt: "2024-01-15T12:00:00.000Z",
        },
      })) {
        // consume
      }

      // Drive items URL should include $filter with lastModifiedDateTime
      // calls: [0]=token, [1]=site, [2]=token(drives), [3]=driveList, [4]=driveItems
      const driveCallUrl = (fetchMock.mock.calls[4] as unknown[])[0] as string;
      expect(decodeURIComponent(driveCallUrl)).toContain(
        "$filter=lastModifiedDateTime",
      );
    });

    it("skips page and records failure when file download fails", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([
          makeDriveItem("item-1", "good.txt"),
          makeDriveItem("item-2", "bad.txt"),
        ]),
      );
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Good content"));
      // bad.txt download fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only good.txt is returned, bad.txt skipped
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("good.txt");
      const failures = batches[0].failures ?? [];
      expect(failures).toHaveLength(1);
      expect(failures[0]?.itemId).toBe("item-2");
    });

    it("throws when drive items endpoint returns error", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse(["drive-1"]));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      } as unknown as Response);

      const generator = connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow(
        "Drive items query failed",
      );
    });
  });

  describe("sync — site pages", () => {
    it("syncs site pages with web part content", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      // Empty drive list — no drive items to sync
      fetchMock.mockResolvedValueOnce(makeDriveListResponse([]));
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      // Site pages
      fetchMock.mockResolvedValueOnce(
        makeSitePagesResponse([makeSitePage("page-1", "Welcome Page")]),
      );
      fetchMock.mockResolvedValueOnce(
        makeWebPartsResponse([
          { innerHtml: "<p>Hello <b>world</b></p>" },
          { innerHtml: "<div>More content</div>" },
        ]),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Last batch should be site pages
      const pageBatch = batches[batches.length - 1];
      expect(pageBatch.documents).toHaveLength(1);
      expect(pageBatch.documents[0].title).toBe("Welcome Page");
      expect(pageBatch.documents[0].content).toContain("Hello world");
      expect(pageBatch.documents[0].content).toContain("More content");
      expect(pageBatch.documents[0].id).toBe("page-page-1");
    });

    it("sets checkpoint from last page lastModifiedDateTime", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse([]));
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(
        makeSitePagesResponse([
          makeSitePage("page-1", "First", {
            lastModified: "2024-02-01T00:00:00.000Z",
          }),
          makeSitePage("page-2", "Second", {
            lastModified: "2024-03-01T00:00:00.000Z",
          }),
        ]),
      );
      fetchMock.mockResolvedValueOnce(makeWebPartsResponse([]));
      fetchMock.mockResolvedValueOnce(makeWebPartsResponse([]));

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const cp = batches[batches.length - 1].checkpoint as Record<
        string,
        unknown
      >;
      expect(cp.lastSyncedAt).toBe("2024-03-01T00:00:00.000Z");
    });
  });

  describe("sync — config options", () => {
    it("uses specific driveIds when provided", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      // No listDriveIds call since driveIds provided
      fetchMock.mockResolvedValueOnce(
        makeDriveItemsResponse([makeDriveItem("item-1", "file.txt")]),
      );
      fetchMock.mockResolvedValueOnce(makeFileContentResponse("Content"));
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // pages phase
      fetchMock.mockResolvedValueOnce(makeSitePagesResponse([]));

      for await (const _ of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          driveIds: ["specific-drive"],
        },
        credentials,
        checkpoint: null,
      })) {
        // consume
      }

      // Should NOT have called /drives to list — goes directly to specific drive
      const urls = fetchMock.mock.calls.map(
        (c) => (c as unknown[])[0] as string,
      );
      expect(urls.some((u) => u.includes("/drives/specific-drive/"))).toBe(
        true,
      );
      expect(urls.some((u) => u.includes("/drives?$select=id"))).toBe(false);
    });

    it("skips site pages when includePages is false", async () => {
      const connector = new SharePointConnector();
      const fetchMock = spyFetch(connector);

      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // initial
      fetchMock.mockResolvedValueOnce(makeSiteResponse());
      fetchMock.mockResolvedValueOnce(makeTokenResponse()); // drives phase
      fetchMock.mockResolvedValueOnce(makeDriveListResponse([]));
      // No site pages call expected

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          tenantId: "test-tenant-id",
          siteUrl: "https://tenant.sharepoint.com/sites/test",
          includePages: false,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // No site pages URL called
      const urls = fetchMock.mock.calls.map(
        (c) => (c as unknown[])[0] as string,
      );
      expect(urls.some((u) => u.includes("/pages"))).toBe(false);
    });
  });
});
