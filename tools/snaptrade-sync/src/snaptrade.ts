import { Snaptrade } from "snaptrade-typescript-sdk";
import { z } from "zod";

const underlyingSchema = z.object({ symbol: z.string() }).passthrough();
const optionSymbolSchema = z.object({
  ticker: z.string(),
  strike_price: z.number(),
  expiration_date: z.string(),
  is_mini_option: z.boolean().nullish(),
  option_type: z.enum(["CALL", "PUT"]),
  underlying_symbol: underlyingSchema,
}).passthrough();

export const optionPositionSchema = z.object({
  symbol: z.object({ option_symbol: optionSymbolSchema }).passthrough(),
  price: z.number().nullable(),
  units: z.number(),
  currency: z.any().nullish(),
  average_purchase_price: z.number().nullable(),
}).passthrough();

export const equityPositionSchema = z.object({
  symbol: z.object({
    symbol: z.string(),
    exchange: z.object({ mic_code: z.string().nullish() }).passthrough().nullish(),
  }).passthrough(),
  price: z.number().nullable(),
  units: z.number(),
  currency: z.any().nullish(),
  average_purchase_price: z.number().nullable(),
}).passthrough();

export const balanceSchema = z.object({
  currency: z.object({ code: z.string() }).passthrough(),
  cash: z.number(),
}).passthrough();

export const holdingsSchema = z.object({
  positions: z.array(equityPositionSchema).default([]),
  option_positions: z.array(optionPositionSchema).default([]),
  balances: z.array(balanceSchema).default([]),
}).passthrough();

export type Holdings = z.infer<typeof holdingsSchema>;
export type OptionPosition = z.infer<typeof optionPositionSchema>;
export type EquityPosition = z.infer<typeof equityPositionSchema>;

export function parseHoldings(raw: unknown): Holdings {
  return holdingsSchema.parse(raw);
}

export function makeClient(clientId: string, consumerKey: string): Snaptrade {
  return new Snaptrade({ clientId, consumerKey });
}

export async function listAccounts(client: Snaptrade, userId: string, userSecret: string) {
  const { data } = await client.accountInformation.listUserAccounts({ userId, userSecret });
  return data as Array<{ id: string; name: string; institution_name: string }>;
}

export async function fetchHoldings(
  client: Snaptrade, userId: string, userSecret: string, accountId: string,
): Promise<Holdings> {
  const { data } = await client.accountInformation.getUserHoldings({ userId, userSecret, accountId });
  return parseHoldings(data);
}
