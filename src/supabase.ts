import { createClient } from "@supabase/supabase-js";

import type { AppData } from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null;

function isMissingRpcSignature(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "PGRST202";
}

export async function joinRoom(slug: string, passwordHash: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase.rpc("join_room", {
    p_slug: slug,
    p_password_hash: passwordHash,
  });

  if (error) throw error;
  return data as AppData;
}

export async function loginPlayer(slug: string, passwordHash: string, playerId: string, pinHash: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase.rpc("login_player", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_player_id: playerId,
    p_pin_hash: pinHash,
  });

  if (error) throw error;
  return data as boolean;
}

export async function upsertPlayer(slug: string, passwordHash: string, adminHash: string, player: { id?: string; name: string; iban?: string; accountName?: string; pinHash?: string }) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("upsert_player", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_admin_hash: adminHash,
    p_player_id: player.id ?? null,
    p_name: player.name,
    p_iban: player.iban ?? "",
    p_account_name: player.accountName ?? "",
    p_pin_hash: player.pinHash ?? null,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("upsert_player", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_player_id: player.id ?? null,
      p_name: player.name,
      p_iban: player.iban ?? "",
      p_account_name: player.accountName ?? "",
      p_pin_hash: player.pinHash ?? null,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}

export async function deletePlayer(slug: string, passwordHash: string, adminHash: string, playerId: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("delete_player", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_admin_hash: adminHash,
    p_player_id: playerId,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("delete_player", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_player_id: playerId,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}

export async function addMatchResult(slug: string, passwordHash: string, match: { id: string; stake: number; winnerIds: string[]; loserIds: string[]; receiveFromByWinner: Record<string, string[]> }) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("add_match_result", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_match_id: match.id,
    p_stake: match.stake,
    p_winner_ids: match.winnerIds,
    p_loser_ids: match.loserIds,
    p_receive_from_by_winner: match.receiveFromByWinner,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("add_match_result", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_stake: match.stake,
      p_winner_ids: match.winnerIds,
      p_loser_ids: match.loserIds,
      p_receive_from_by_winner: match.receiveFromByWinner,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}

export async function deleteMatchResult(slug: string, passwordHash: string, adminHash: string, matchId: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("delete_match_result", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_admin_hash: adminHash,
    p_match_id: matchId,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("delete_match_result", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_match_id: matchId,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}

export async function markSettlementPaid(slug: string, passwordHash: string, fromPlayerId: string, toPlayerId: string, amount: number) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase.rpc("mark_settlement_paid", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_from_player_id: fromPlayerId,
    p_to_player_id: toPlayerId,
    p_amount: amount,
  });

  if (error) throw error;
  return data as AppData;
}

export async function cancelSettlementPaid(slug: string, passwordHash: string, settlementId: string, actorPlayerId: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("cancel_settlement_paid", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_settlement_id: settlementId,
    p_actor_player_id: actorPlayerId,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("cancel_settlement_paid", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_settlement_id: settlementId,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}

export async function confirmSettlementReceived(slug: string, passwordHash: string, adminHash: string, settlementId: string, confirmerPlayerId: string | null) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  let { data, error } = await supabase.rpc("confirm_settlement_received", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_admin_hash: adminHash,
    p_settlement_id: settlementId,
    p_confirmer_player_id: confirmerPlayerId,
  });

  if (isMissingRpcSignature(error)) {
    const legacyResult = await supabase.rpc("confirm_settlement_received", {
      p_slug: slug,
      p_password_hash: passwordHash,
      p_settlement_id: settlementId,
      p_confirmer_player_id: confirmerPlayerId,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) throw error;
  return data as AppData;
}
