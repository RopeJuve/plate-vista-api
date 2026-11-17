import { z } from "zod";

export const updatePayoutAccountSchema = z.object({
  onlinePaymentsEnabled: z.boolean({ error: "onlinePaymentsEnabled must be true or false" }),
});
