/**
 * Provider schemas — describe what each "provider" cred record actually
 * contains. The vault stores encrypted JSON; these schemas validate the
 * plaintext shape on write and guarantee the shape on read.
 *
 * Adding a new provider is one entry in the map plus updating
 * `ProviderName`. The vault endpoint validates against the right schema
 * per `:provider` path parameter, so drift between the API and the stored
 * shape is caught early.
 *
 * Security note: we validate fields (required, string, non-empty) but do
 * NOT normalize values. Whitespace, casing, URL format — those stay as the
 * user typed them. Matching Salesforce's own tolerance is the caller's job.
 */

import { z } from "zod";

/** Non-empty trimmed string. */
const nonEmpty = z.string().min(1).max(4096);

export const SalesforceCredSchema = z.object({
  client_id: nonEmpty,
  client_secret: nonEmpty,
  username: z.string().email().max(320),
  password: nonEmpty,
  instance_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "instance_url must use https://",
    }),
});
export type SalesforceCred = z.infer<typeof SalesforceCredSchema>;

export const AtlassianCredSchema = z.object({
  /** The user's Atlassian account email. */
  email: z.string().email().max(320),
  /** Scoped API token (atlassian.com/manage-profile/security/api-tokens). */
  api_token: nonEmpty,
});
export type AtlassianCred = z.infer<typeof AtlassianCredSchema>;

export const ProviderSchemas = {
  salesforce: SalesforceCredSchema,
  atlassian: AtlassianCredSchema,
} as const;

export type ProviderName = keyof typeof ProviderSchemas;

export function isProviderName(x: string): x is ProviderName {
  return x in ProviderSchemas;
}

/** Validate an unknown payload against the schema for a specific provider.
 *  Returns the typed value or a human-readable error message. */
export function validateCred(
  provider: ProviderName,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = ProviderSchemas[provider];
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: errors };
}
