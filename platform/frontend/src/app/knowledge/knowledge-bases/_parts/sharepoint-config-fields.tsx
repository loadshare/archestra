"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface SharePointConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
}

export function SharePointConfigFields({
  form,
  prefix = "config",
  hideUrl: _hideUrl,
}: SharePointConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.driveIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Drive IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="b!abc123, b!def456"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of document library (drive) IDs to sync.
              Leave blank to sync all document libraries in the site.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.folderPath`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder Path (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="General/Documents/Engineering"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Restrict sync to a specific folder path within each drive.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
