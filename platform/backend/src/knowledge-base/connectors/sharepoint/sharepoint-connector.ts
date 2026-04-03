import JSZip from "jszip";
import mammoth from "mammoth";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  SharePointCheckpoint,
  SharePointConfig,
} from "@/types";
import { SharePointConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT_LENGTH = 500_000; // 500 KB text limit per document
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// File extensions whose text content we can extract via Graph download
const SUPPORTED_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
]);

// Binary file extensions we can extract text from using libraries
const SUPPORTED_BINARY_EXTENSIONS = new Set([".docx", ".pdf", ".pptx"]);

export class SharePointConnector extends BaseConnector {
  type = "sharepoint" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSharePointConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid SharePoint configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing SharePoint connection");

    try {
      const config = parseSharePointConfig(params.config);
      if (!config) {
        return { success: false, error: "Invalid configuration" };
      }

      const token = await this.getAccessToken(params.credentials, config);
      const siteId = await this.resolveSiteId(token, config.siteUrl);

      if (!siteId) {
        return {
          success: false,
          error:
            "Could not resolve SharePoint site. Verify the site URL and app permissions.",
        };
      }

      this.log.debug("SharePoint connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "SharePoint connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseSharePointConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid SharePoint configuration");
    }

    const checkpoint = (params.checkpoint as SharePointCheckpoint | null) ?? {
      type: "sharepoint" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    // Helper to get a fresh token (Azure AD tokens expire after ~60 min).
    // Re-acquiring before each sync phase prevents failures during long syncs.
    const freshToken = () => this.getAccessToken(params.credentials, parsed);

    const token = await freshToken();
    const siteId = await this.resolveSiteId(token, parsed.siteUrl);

    if (!siteId) {
      throw new Error(
        "Could not resolve SharePoint site. Verify the site URL and app permissions.",
      );
    }

    this.log.debug(
      {
        siteId,
        driveIds: parsed.driveIds,
        folderPath: parsed.folderPath,
        includePages: parsed.includePages,
        syncFrom,
      },
      "Starting SharePoint sync",
    );

    // Sync drive items (documents/files)
    yield* this.syncDriveItems({
      token: await freshToken(),
      siteId,
      config: parsed,
      checkpoint,
      syncFrom: safetyBufferedSyncFrom,
      batchSize,
    });

    // Sync site pages if enabled
    if (parsed.includePages !== false) {
      yield* this.syncSitePages({
        token: await freshToken(),
        siteId,
        checkpoint,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
      });
    }
  }

  // ===== Private methods =====

  private async getAccessToken(
    credentials: ConnectorCredentials,
    config: SharePointConfig,
  ): Promise<string> {
    const tenantId = config.tenantId;
    const clientId = credentials.email;
    const clientSecret = credentials.apiToken;

    if (!clientId) {
      throw new Error("Client ID is required (provide in Email field)");
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await this.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OAuth token request failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const result = (await response.json()) as { access_token: string };
    return result.access_token;
  }

  private async resolveSiteId(
    token: string,
    siteUrl: string,
  ): Promise<string | null> {
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname.replace(/^\//, "").replace(/\/$/, "");

    const graphUrl = sitePath
      ? `${GRAPH_API_BASE}/sites/${hostname}:/${sitePath}`
      : `${GRAPH_API_BASE}/sites/${hostname}`;

    const response = await this.fetchWithRetry(graphUrl, {
      headers: buildGraphHeaders(token),
    });

    if (!response.ok) return null;

    const site = (await response.json()) as { id: string };
    return site.id;
  }

  private async *syncDriveItems(params: {
    token: string;
    siteId: string;
    config: SharePointConfig;
    checkpoint: SharePointCheckpoint;
    syncFrom: string | undefined;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { token, siteId, config, checkpoint, syncFrom, batchSize } = params;

    const driveIds =
      config.driveIds && config.driveIds.length > 0
        ? config.driveIds
        : await this.listDriveIds(token, siteId);

    for (let i = 0; i < driveIds.length; i++) {
      const driveId = driveIds[i];
      const isLastDrive = i === driveIds.length - 1;

      yield* this.syncSingleDrive({
        token,
        driveId,
        folderPath: config.folderPath,
        checkpoint,
        syncFrom,
        batchSize,
        hasMoreDrives: !isLastDrive,
      });
    }
  }

  private async listDriveIds(token: string, siteId: string): Promise<string[]> {
    const response = await this.fetchWithRetry(
      `${GRAPH_API_BASE}/sites/${siteId}/drives?$select=id`,
      { headers: buildGraphHeaders(token) },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to list drives: HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const result = (await response.json()) as {
      value: Array<{ id: string }>;
    };
    return result.value.map((d) => d.id);
  }

  private async *syncSingleDrive(params: {
    token: string;
    driveId: string;
    folderPath: string | undefined;
    checkpoint: SharePointCheckpoint;
    syncFrom: string | undefined;
    batchSize: number;
    hasMoreDrives: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      token,
      driveId,
      folderPath,
      checkpoint,
      syncFrom,
      batchSize,
      hasMoreDrives,
    } = params;

    let url = buildDriveItemsUrl(driveId, folderPath, syncFrom, batchSize);
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      const response = await this.fetchWithRetry(url, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Drive items query failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const result = (await response.json()) as GraphListResponse<DriveItem>;
      const items = result.value.filter(
        (item) => item.file && !item.folder && isSupportedFile(item.name),
      );

      const documents: ConnectorDocument[] = [];

      for (const item of items) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.downloadFileContent(
              token,
              driveId,
              item.id,
              item.name,
            );
            // Skip files with no extractable content to avoid indexing
            // title-only documents that provide no search value.
            if (!content.trim()) return null;
            return driveItemToDocument(item, driveId, content);
          },
          fallback: null,
          itemId: item.id,
          resource: "driveItem",
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMore = !!nextLink;
      if (nextLink) url = nextLink;

      // Use unfiltered results for checkpoint so it advances past non-text
      // files that were skipped by the client-side filter.
      const lastResult = result.value[result.value.length - 1];
      const lastModified = lastResult?.lastModifiedDateTime;

      batchIndex++;
      this.log.debug(
        {
          driveId,
          batchIndex,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: hasMore || hasMoreDrives,
        },
        "SharePoint drive batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: lastModified ? new Date(lastModified) : undefined,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMore || hasMoreDrives,
      };
    }
  }

  private async downloadFileContent(
    token: string,
    driveId: string,
    itemId: string,
    fileName: string,
  ): Promise<string> {
    const ext = getFileExtension(fileName);
    const contentUrl = `${GRAPH_API_BASE}/drives/${driveId}/items/${itemId}/content`;

    // Plain text files: download and read as text
    if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
      const response = await this.fetchWithRetry(contentUrl, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Failed to download ${fileName}: HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const text = await response.text();
      return text.slice(0, MAX_CONTENT_LENGTH);
    }

    // Binary files (.docx, .pdf, .pptx): download as buffer and extract text
    if (SUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const response = await this.fetchWithRetry(contentUrl, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Failed to download ${fileName}: HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const text = await extractTextFromBinary(buffer, ext);
      return text.slice(0, MAX_CONTENT_LENGTH);
    }

    return "";
  }

  private async *syncSitePages(params: {
    token: string;
    siteId: string;
    checkpoint: SharePointCheckpoint;
    syncFrom: string | undefined;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { token, siteId, checkpoint, syncFrom, batchSize } = params;

    let url = buildSitePagesUrl(siteId, syncFrom, batchSize);
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      const response = await this.fetchWithRetry(url, {
        headers: buildGraphHeaders(token),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Site pages query failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const result = (await response.json()) as GraphListResponse<SitePage>;
      const documents: ConnectorDocument[] = [];

      for (const page of result.value) {
        const doc = await this.safeItemFetch({
          fetch: async () => {
            const content = await this.fetchPageContent(token, siteId, page.id);
            // Skip pages with no extractable content to avoid indexing
            // title-only documents that provide no search value.
            if (!content.trim()) return null;
            return sitePageToDocument(page, siteId, content);
          },
          fallback: null,
          itemId: page.id,
          resource: "sitePage",
        });
        if (doc) documents.push(doc);
      }

      const nextLink = result["@odata.nextLink"];
      hasMore = !!nextLink;
      if (nextLink) url = nextLink;

      const lastPage = result.value[result.value.length - 1];
      const lastModified = lastPage?.lastModifiedDateTime;

      batchIndex++;
      this.log.debug(
        {
          batchIndex,
          pageCount: result.value.length,
          documentCount: documents.length,
          hasMore,
        },
        "SharePoint site pages batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "sharepoint",
          itemUpdatedAt: lastModified ? new Date(lastModified) : undefined,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchPageContent(
    token: string,
    siteId: string,
    pageId: string,
  ): Promise<string> {
    const response = await this.fetchWithRetry(
      `${GRAPH_API_BASE}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/webParts`,
      { headers: buildGraphHeaders(token) },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to fetch page content for ${pageId}: HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const result = (await response.json()) as {
      value: Array<{
        "@odata.type"?: string;
        innerHtml?: string;
        data?: { properties?: Record<string, unknown> };
      }>;
    };

    const parts: string[] = [];
    for (const webPart of result.value) {
      if (webPart.innerHtml) {
        parts.push(stripHtml(webPart.innerHtml));
      }
    }

    return parts.join("\n\n").slice(0, MAX_CONTENT_LENGTH);
  }
}

// ===== Module-level helpers =====

type GraphListResponse<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

type DriveItem = {
  id: string;
  name: string;
  webUrl: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  size: number;
  file?: { mimeType: string };
  folder?: { childCount: number };
  parentReference?: { path: string };
};

type SitePage = {
  id: string;
  name: string;
  title: string;
  webUrl: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  description?: string;
};

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function buildGraphHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function parseSharePointConfig(
  config: Record<string, unknown>,
): SharePointConfig | null {
  const result = SharePointConfigSchema.safeParse({
    type: "sharepoint",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildDriveItemsUrl(
  driveId: string,
  folderPath: string | undefined,
  syncFrom: string | undefined,
  batchSize: number,
): string {
  const basePath = folderPath
    ? `${GRAPH_API_BASE}/drives/${driveId}/root:/${encodeURIComponent(folderPath)}:/children`
    : `${GRAPH_API_BASE}/drives/${driveId}/root/children`;

  const params = new URLSearchParams({
    $select:
      "id,name,webUrl,lastModifiedDateTime,createdDateTime,size,file,folder,parentReference",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  if (syncFrom) {
    params.set("$filter", `lastModifiedDateTime ge ${syncFrom}`);
  }

  return `${basePath}?${params.toString()}`;
}

function buildSitePagesUrl(
  siteId: string,
  syncFrom: string | undefined,
  batchSize: number,
): string {
  const params = new URLSearchParams({
    $select:
      "id,name,title,webUrl,lastModifiedDateTime,createdDateTime,description",
    $orderby: "lastModifiedDateTime asc",
    $top: String(batchSize),
  });

  if (syncFrom) {
    params.set("$filter", `lastModifiedDateTime ge ${syncFrom}`);
  }

  return `${GRAPH_API_BASE}/sites/${siteId}/pages?${params.toString()}`;
}

function isSupportedFile(name: string): boolean {
  const ext = getFileExtension(name);
  return (
    SUPPORTED_TEXT_EXTENSIONS.has(ext) || SUPPORTED_BINARY_EXTENSIONS.has(ext)
  );
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0) return "";
  return name.slice(lastDot).toLowerCase();
}

async function extractTextFromBinary(
  buffer: Buffer,
  ext: string,
): Promise<string> {
  switch (ext) {
    case ".docx": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case ".pdf": {
      // Lazy import: pdf-parse v1 tries to load a test file at import time
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(buffer);
      return result.text;
    }
    case ".pptx": {
      return extractTextFromPptx(buffer);
    }
    default:
      return "";
  }
}

async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: string[] = [];

  // PPTX slides are stored as ppt/slides/slide1.xml, slide2.xml, etc.
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text");
    // Extract text from <a:t> tags (DrawingML text runs)
    const texts = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
    if (texts) {
      const slideText = texts.map((t) => t.replace(/<[^>]+>/g, "")).join(" ");
      if (slideText.trim()) parts.push(slideText.trim());
    }
  }

  return parts.join("\n\n");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function driveItemToDocument(
  item: DriveItem,
  driveId: string,
  content: string,
): ConnectorDocument {
  const title = item.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: item.id,
    title,
    content: fullContent,
    sourceUrl: item.webUrl,
    metadata: {
      driveId,
      driveItemId: item.id,
      fileName: item.name,
      mimeType: item.file?.mimeType,
      size: item.size,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdDateTime: item.createdDateTime,
      parentPath: item.parentReference?.path,
    },
    updatedAt: new Date(item.lastModifiedDateTime),
  };
}

function sitePageToDocument(
  page: SitePage,
  siteId: string,
  content: string,
): ConnectorDocument {
  const title = page.title || page.name;
  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id: `page-${page.id}`,
    title,
    content: fullContent,
    sourceUrl: page.webUrl,
    metadata: {
      siteId,
      pageId: page.id,
      pageName: page.name,
      description: page.description,
      lastModifiedDateTime: page.lastModifiedDateTime,
      createdDateTime: page.createdDateTime,
    },
    updatedAt: new Date(page.lastModifiedDateTime),
  };
}
