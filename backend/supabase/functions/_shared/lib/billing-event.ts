import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** A persisted receipt is not a successful reconciliation. Failed work may retry. */
export async function recordBillingEvent(
  db: SupabaseClient,
  event: {id:string;type:string;created:number;data:{object:unknown}},
): Promise<"process"|"duplicate"> {
  const {error} = await db.from("billing_events").insert({
    stripe_event_id:event.id,type:event.type,
    occurred_at:new Date(event.created*1000).toISOString(),raw:event.data.object,
  });
  if (!error) return "process";
  if (error.code!=="23505") throw error;
  const {data:previous,error:readError}=await db.from("billing_events").select("processed_at").eq("stripe_event_id",event.id).maybeSingle();
  if (readError) throw readError;
  return previous?.processed_at ? "duplicate" : "process";
}
