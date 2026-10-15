import { z } from "zod";

export const lineNamingStatusSchema = z.enum(["pending", "generating", "ready", "failed"]);
export const lineListStatusSchema = z.enum(["active", "completed", "archived", "all"]);
export const lineCompletionStatusSchema = z.enum(["active", "completed", "cancelled"]);

/** A stored model result uses normalized single spaces and contains no markup or control characters. */
export const lineNameSchema = z.string().max(80).regex(/^[^\s<>]+(?: [^\s<>]+){1,5}$/u);

export const listLinesQuerySchema = z.object({
  status: lineListStatusSchema.optional().default("active"),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().min(1).max(500).optional(),
}).strict();

export const createLineSchema = z.object({ rootIssueId: z.string().uuid() }).strict();
export const updateLineSchema = z.object({ archived: z.boolean() }).strict();
export const retryLineNamingSchema = z.object({}).strict();
/** The caller's run ID is checked against authenticated runtime context, never trusted on its own. */
export const lineNamingResultSchema = z.object({
  namingVersion: z.number().int().nonnegative(),
  namingIssueId: z.string().uuid(),
  runId: z.string().uuid(),
  name: lineNameSchema,
}).strict();

export const issueLineFilterSchema = z.union([z.string().uuid(), z.literal("ungrouped")]);

export type ListLinesQuery = z.infer<typeof listLinesQuerySchema>;
export type CreateLine = z.infer<typeof createLineSchema>;
export type UpdateLine = z.infer<typeof updateLineSchema>;
export type LineNamingResult = z.infer<typeof lineNamingResultSchema>;
