import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Cloud, Copy, Home, Plus, QrCode, Swords, Trash2, Trophy, Users } from "lucide-react";
import QRCode from "qrcode";

import {
  addMatchResult,
  cancelSettlementPaid,
  confirmSettlementReceived,
  deleteMatchResult,
  deletePlayer,
  isSupabaseConfigured,
  joinRoom,
  loginPlayer,
  markSettlementPaid,
  upsertPlayer,
} from "./supabase";
import type { AppData, Match, Player, Settlement } from "./types";

type Payout = {
  from: string;
  to: string;
  amount: number;
};

type PlayerTotals = {
  incoming: number;
  outgoing: number;
};

type Page = "home" | "users" | "matches" | "leaderboard";

const ROOM_SESSION_KEY = "doekoe.activeRoom.v1";
const ADMIN_SESSION_KEY = "doekoe.admin.v1";
const PLAYER_SESSION_KEY = "doekoe.activePlayer.v1";
const MIN_PAYOUT = 10;
const ADMIN_CODE = import.meta.env.VITE_ADMIN_CODE?.trim() ?? "";
const EMPTY_DATA: AppData = { players: [], matches: [], settlements: [] };

const currency = new Intl.NumberFormat("nl-NL", {
  style: "currency",
  currency: "EUR",
});

function createId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function toggleSelected(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function slugifyRoomName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeReceiveMap(value: unknown): Record<string, string[]> {
  if (typeof value === "string") {
    try {
      return normalizeReceiveMap(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([winnerId, payerIds]) => [winnerId, normalizeStringArray(payerIds)]));
}

function normalizeData(value: AppData | null | undefined): AppData {
  return {
    players: (value?.players ?? []).map((player) => ({
      ...player,
      id: String(player.id),
      name: player.name ?? "",
      iban: player.iban ?? "",
      accountName: player.accountName ?? "",
    })),
    matches: (value?.matches ?? []).map((match) => ({
      ...match,
      id: String(match.id),
      createdAt: Number(match.createdAt),
      stake: Number(match.stake),
      winnerIds: normalizeStringArray(match.winnerIds),
      loserIds: normalizeStringArray(match.loserIds),
      receiveFromByWinner: normalizeReceiveMap(match.receiveFromByWinner),
    })),
    settlements: (value?.settlements ?? []).map((settlement) => ({
      ...settlement,
      id: String(settlement.id),
      from: String(settlement.from),
      to: String(settlement.to),
      amount: Number(settlement.amount),
      createdAt: Number(settlement.createdAt),
    })),
  };
}

function mergeRoomData(current: AppData, incoming: AppData): AppData {
  const currentMatchById = new Map(current.matches.map((match) => [match.id, match]));

  return {
    ...incoming,
    matches: incoming.matches.map((match) => {
      const currentMatch = currentMatchById.get(match.id);
      if (!currentMatch) return match;

      return {
        ...match,
        winnerIds: match.winnerIds.length ? match.winnerIds : currentMatch.winnerIds,
        loserIds: match.loserIds.length ? match.loserIds : currentMatch.loserIds,
        receiveFromByWinner: Object.keys(match.receiveFromByWinner).length ? match.receiveFromByWinner : currentMatch.receiveFromByWinner,
      };
    }),
  };
}

async function hashPassword(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildSepaQrValue(receiver: Player, payerName: string, amount: number) {
  const accountName = (receiver.accountName || receiver.name).slice(0, 70);
  const description = `${payerName} please pay me ${currency.format(amount)}`.slice(0, 140);
  return ["BCD", "002", "1", "SCT", "", accountName, (receiver.iban ?? "").replace(/\s+/g, "").toUpperCase(), `EUR${amount.toFixed(2)}`, "", "", description].join("\n");
}

function buildPaymentDetails(receiver: Player, payerName: string, amount: number) {
  return [`Amount: ${currency.format(amount)}`, `To: ${receiver.accountName || receiver.name}`, `IBAN: ${receiver.iban ?? ""}`, `Description: ${payerName} please pay me ${currency.format(amount)}`].join("\n");
}

function calculateBalances(players: Player[], matches: Match[], settlements: Settlement[]) {
  const playerIds = new Set(players.map((player) => player.id));
  const pairTotals = new Map<string, Payout>();
  const events = [
    ...matches.map((match) => ({ type: "match" as const, createdAt: match.createdAt, match })),
    ...settlements
      .filter((settlement) => settlement.status === "confirmed_received")
      .map((settlement) => ({ type: "settlement" as const, createdAt: settlement.confirmedAt ?? settlement.createdAt, settlement })),
  ].sort((a, b) => a.createdAt - b.createdAt);

  for (const event of events) {
    if (event.type === "settlement") {
      const settlement = event.settlement;
      const key = `${settlement.from}->${settlement.to}`;
      const existing = pairTotals.get(key);
      if (!existing) continue;

      const nextAmount = roundMoney(existing.amount - settlement.amount);
      if (nextAmount > 0) pairTotals.set(key, { ...existing, amount: nextAmount });
      else pairTotals.delete(key);
      continue;
    }

    const match = event.match;
    for (const winnerId of match.winnerIds) {
      const payers = match.receiveFromByWinner[winnerId]?.length ? match.receiveFromByWinner[winnerId] : match.loserIds;

      for (const payerId of payers) {
        if (payerId === winnerId || !playerIds.has(payerId) || !playerIds.has(winnerId)) continue;

        const key = `${payerId}->${winnerId}`;
        const existing = pairTotals.get(key);
        pairTotals.set(key, {
          from: payerId,
          to: winnerId,
          amount: roundMoney((existing?.amount ?? 0) + match.stake),
        });
      }
    }
  }

  const payouts = [...pairTotals.values()]
    .filter((payout) => payout.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const playerTotals = new Map<string, PlayerTotals>(players.map((player) => [player.id, { incoming: 0, outgoing: 0 }]));
  for (const payout of payouts) {
    const receiver = playerTotals.get(payout.to);
    const payer = playerTotals.get(payout.from);
    if (receiver) receiver.incoming = roundMoney(receiver.incoming + payout.amount);
    if (payer) payer.outgoing = roundMoney(payer.outgoing + payout.amount);
  }

  return {
    playerTotals,
    payouts,
    obliged: payouts.filter((payout) => payout.amount >= MIN_PAYOUT),
  };
}

function PaymentQr({ value }: { value: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 180 }).then((nextSrc) => {
      if (!cancelled) setSrc(nextSrc);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!src) return null;
  return <img className="payment-qr" src={src} alt="Payment QR code" />;
}

function App() {
  const [data, setData] = useState<AppData>(EMPTY_DATA);
  const [roomName, setRoomName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [activeRoom, setActiveRoom] = useState<{ slug: string; passwordHash: string } | null>(() => {
    try {
      const saved = localStorage.getItem(ROOM_SESSION_KEY);
      return saved ? (JSON.parse(saved) as { slug: string; passwordHash: string }) : null;
    } catch {
      return null;
    }
  });
  const [activePlayerId, setActivePlayerId] = useState(() => localStorage.getItem(PLAYER_SESSION_KEY) ?? "");
  const [roomError, setRoomError] = useState("");
  const [syncStatus, setSyncStatus] = useState(isSupabaseConfigured ? "Join a room to sync" : "Add Supabase env vars to enable shared rooms");
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const [adminCode, setAdminCode] = useState("");
  const [adminHash, setAdminHash] = useState(() => localStorage.getItem(ADMIN_SESSION_KEY) ?? "");
  const [adminError, setAdminError] = useState("");
  const [playerLoginId, setPlayerLoginId] = useState("");
  const [playerPin, setPlayerPin] = useState("");
  const [playerLoginError, setPlayerLoginError] = useState("");
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerIban, setNewPlayerIban] = useState("");
  const [newPlayerAccountName, setNewPlayerAccountName] = useState("");
  const [newPlayerPin, setNewPlayerPin] = useState("");
  const [pinDraftByPlayer, setPinDraftByPlayer] = useState<Record<string, string>>({});
  const [stake, setStake] = useState("10");
  const [winnerIds, setWinnerIds] = useState<string[]>([]);
  const [loserIds, setLoserIds] = useState<string[]>([]);
  const [receiveFromByWinner, setReceiveFromByWinner] = useState<Record<string, string[]>>({});
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [copiedPayoutKey, setCopiedPayoutKey] = useState("");
  const isEditingRef = useRef(false);

  const activePlayer = data.players.find((player) => player.id === activePlayerId) ?? null;
  const canManage = adminHash.length > 0;
  const playerNameById = useMemo(() => new Map(data.players.map((player) => [player.id, player.name])), [data.players]);
  const playerById = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
  const { playerTotals, payouts, obliged } = useMemo(() => calculateBalances(data.players, data.matches, data.settlements), [data.players, data.matches, data.settlements]);
  const leaderboard = useMemo(
    () =>
      data.players
        .map((player) => {
          const totals = playerTotals.get(player.id) ?? { incoming: 0, outgoing: 0 };
          return {
            player,
            incoming: totals.incoming,
            outgoing: totals.outgoing,
            net: roundMoney(totals.incoming - totals.outgoing),
          };
        })
        .sort((a, b) => b.net - a.net),
    [data.players, playerTotals],
  );
  const totalInPlay = data.matches.reduce((sum, match) => {
    const matchPayers = match.winnerIds.reduce((count, winnerId) => count + (match.receiveFromByWinner[winnerId]?.length || match.loserIds.length), 0);
    return roundMoney(sum + match.stake * matchPayers);
  }, 0);
  const pendingSettlements = data.settlements.filter((settlement) => settlement.status === "marked_paid");
  const activePlayerObligedPayouts = activePlayer ? payouts.filter((payout) => payout.from === activePlayer.id && payout.amount >= MIN_PAYOUT) : [];
  const stakeAmount = Number(stake);
  const canAddMatch = Boolean(activeRoom) && stakeAmount > 0 && winnerIds.length > 0 && loserIds.length > 0;
  const roomLocked = isSupabaseConfigured && !activeRoom;

  useEffect(() => {
    if (!activeRoom) {
      localStorage.removeItem(ROOM_SESSION_KEY);
      setData(EMPTY_DATA);
      return;
    }
    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(activeRoom));
  }, [activeRoom]);

  useEffect(() => {
    if (activePlayerId) localStorage.setItem(PLAYER_SESSION_KEY, activePlayerId);
    else localStorage.removeItem(PLAYER_SESSION_KEY);
  }, [activePlayerId]);

  useEffect(() => {
    if (roomLocked && currentPage !== "home") setCurrentPage("home");
    if (!canManage && currentPage === "users") setCurrentPage("home");
  }, [canManage, currentPage, roomLocked]);

  useEffect(() => {
    if (!activeRoom || !isSupabaseConfigured) return;

    let cancelled = false;
    const room = activeRoom;

    async function loadRoom() {
      if (isEditingRef.current) return;

      try {
        const remoteData = normalizeData(await joinRoom(room.slug, room.passwordHash));
        if (cancelled) return;
        setData((current) => mergeRoomData(current, remoteData));
        setSyncStatus("Room synced");
      } catch (error) {
        if (cancelled) return;
        setRoomError(error instanceof Error ? error.message : "Could not load room");
        setSyncStatus("Room sync failed");
      }
    }

    void loadRoom();
    const intervalId = window.setInterval(loadRoom, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRoom]);

  async function withRoomMutation(action: (room: { slug: string; passwordHash: string }) => Promise<AppData>) {
    if (!activeRoom) return;
    setRoomError("");
    setSyncStatus("Saving...");
    try {
      const remoteData = normalizeData(await action(activeRoom));
      setData((current) => mergeRoomData(current, remoteData));
      setSyncStatus("Saved");
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not save");
      setSyncStatus("Save failed");
    }
  }

  async function unlockAdmin(event: FormEvent) {
    event.preventDefault();
    setAdminError("");

    if (!ADMIN_CODE) {
      setAdminError("Admin code is not configured.");
      return;
    }

    if (adminCode.trim() !== ADMIN_CODE) {
      setAdminError("Wrong admin code.");
      return;
    }

    const nextAdminHash = await hashPassword(`admin:${ADMIN_CODE}`);
    localStorage.setItem(ADMIN_SESSION_KEY, nextAdminHash);
    setAdminHash(nextAdminHash);
    setAdminCode("");
  }

  function lockAdmin() {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminHash("");
    setAdminCode("");
    setAdminError("");
  }

  async function connectRoom(event: FormEvent) {
    event.preventDefault();
    setRoomError("");

    if (!isSupabaseConfigured) {
      setRoomError("Supabase is not configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.");
      return;
    }

    const slug = slugifyRoomName(roomName);
    if (!slug || !roomPassword) {
      setRoomError("Enter a room name and password.");
      return;
    }

    try {
      setIsJoiningRoom(true);
      setSyncStatus("Joining shared room...");
      const passwordHash = await hashPassword(`${slug}:${roomPassword}`);
      const remoteData = normalizeData(await joinRoom(slug, passwordHash));
      setData(remoteData);
      setActiveRoom({ slug, passwordHash });
      setRoomName("");
      setRoomPassword("");
      setSyncStatus("Room synced");
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not join room");
      setSyncStatus("Room join failed");
    } finally {
      setIsJoiningRoom(false);
    }
  }

  function leaveRoom() {
    setActiveRoom(null);
    setActivePlayerId("");
    setRoomError("");
    setSyncStatus(isSupabaseConfigured ? "Join a room to sync" : "Add Supabase env vars to enable shared rooms");
  }

  async function loginAsPlayer(event: FormEvent) {
    event.preventDefault();
    if (!activeRoom || !playerLoginId || !playerPin) return;
    setPlayerLoginError("");

    try {
      const player = data.players.find((candidate) => candidate.id === playerLoginId);
      if (!player) {
        setPlayerLoginError("Choose a player.");
        return;
      }

      const pinHash = await hashPassword(`${playerLoginId}:${playerPin}`);
      const isValid = await loginPlayer(activeRoom.slug, activeRoom.passwordHash, playerLoginId, pinHash);
      if (!isValid) {
        setPlayerLoginError("Wrong player PIN.");
        return;
      }
      setActivePlayerId(playerLoginId);
      setPlayerPin("");
    } catch (error) {
      setPlayerLoginError(error instanceof Error ? error.message : "Could not log in as player");
    }
  }

  async function addPlayer(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !newPlayerName.trim()) return;
    const id = createId();
    const pinHash = newPlayerPin ? await hashPassword(`${id}:${newPlayerPin}`) : undefined;
    await withRoomMutation((room) =>
      upsertPlayer(room.slug, room.passwordHash, adminHash, {
        id,
        name: newPlayerName.trim(),
        iban: newPlayerIban,
        accountName: newPlayerAccountName,
        pinHash,
      }),
    );
    setNewPlayerName("");
    setNewPlayerIban("");
    setNewPlayerAccountName("");
    setNewPlayerPin("");
  }

  function editPlayerLocal(id: string, patch: Partial<Player>) {
    setData((current) => ({ ...current, players: current.players.map((player) => (player.id === id ? { ...player, ...patch } : player)) }));
  }

  async function savePlayer(player: Player) {
    if (!canManage) return;
    await withRoomMutation((room) => upsertPlayer(room.slug, room.passwordHash, adminHash, player));
  }

  async function finishPlayerEdit(player: Player) {
    await savePlayer(player);
    isEditingRef.current = false;
  }

  async function resetPlayerPin(player: Player) {
    if (!canManage) return;
    const pin = pinDraftByPlayer[player.id];
    if (!pin) return;
    const pinHash = await hashPassword(`${player.id}:${pin}`);
    await withRoomMutation((room) => upsertPlayer(room.slug, room.passwordHash, adminHash, { ...player, pinHash }));
    setPinDraftByPlayer((current) => ({ ...current, [player.id]: "" }));
  }

  async function removePlayer(id: string) {
    if (!canManage) return;
    await withRoomMutation((room) => deletePlayer(room.slug, room.passwordHash, adminHash, id));
    if (activePlayerId === id) setActivePlayerId("");
  }

  function toggleWinner(id: string) {
    setWinnerIds((current) => toggleSelected(current, id));
    setLoserIds((current) => current.filter((playerId) => playerId !== id));
  }

  function toggleLoser(id: string) {
    setLoserIds((current) => toggleSelected(current, id));
    setWinnerIds((current) => current.filter((playerId) => playerId !== id));
  }

  function toggleReceiverPayer(winnerId: string, payerId: string) {
    setReceiveFromByWinner((current) => ({
      ...current,
      [winnerId]: toggleSelected(current[winnerId] ?? [], payerId),
    }));
  }

  async function addMatch(event: FormEvent) {
    event.preventDefault();
    if (!canAddMatch || !activeRoom) return;

    const cleanedReceiveMap = Object.fromEntries(
      winnerIds.map((winnerId) => {
        const chosenPayers = receiveFromByWinner[winnerId]?.filter((payerId) => loserIds.includes(payerId)) ?? [];
        return [winnerId, chosenPayers.length ? chosenPayers : loserIds];
      }),
    );

    const optimisticMatch: Match = {
      id: createId(),
      createdAt: Date.now(),
      stake: roundMoney(stakeAmount),
      winnerIds: [...winnerIds],
      loserIds: [...loserIds],
      receiveFromByWinner: cleanedReceiveMap,
    };

    setRoomError("");
    setSyncStatus("Saving...");
    setData((current) => ({ ...current, matches: [optimisticMatch, ...current.matches] }));

    try {
      const remoteData = normalizeData(
        await addMatchResult(activeRoom.slug, activeRoom.passwordHash, {
          id: optimisticMatch.id,
          stake: optimisticMatch.stake,
          winnerIds: optimisticMatch.winnerIds,
          loserIds: optimisticMatch.loserIds,
          receiveFromByWinner: optimisticMatch.receiveFromByWinner,
        }),
      );
      setData((current) => (remoteData.matches.length >= current.matches.length ? mergeRoomData(current, remoteData) : current));
      setSyncStatus("Saved");
    } catch (error) {
      setData((current) => ({ ...current, matches: current.matches.filter((match) => match.id !== optimisticMatch.id) }));
      setRoomError(error instanceof Error ? error.message : "Could not save match");
      setSyncStatus("Save failed");
      return;
    }

    setWinnerIds([]);
    setLoserIds([]);
    setReceiveFromByWinner({});
  }

  async function deleteMatch(id: string) {
    if (!canManage) return;
    await withRoomMutation((room) => deleteMatchResult(room.slug, room.passwordHash, adminHash, id));
  }

  async function copyPaymentDetails(payout: Payout) {
    const receiver = playerById.get(payout.to);
    if (!receiver) return;
    const key = `${payout.from}->${payout.to}`;
    await navigator.clipboard.writeText(buildPaymentDetails(receiver, playerNameById.get(payout.from) ?? "Player", payout.amount));
    setCopiedPayoutKey(key);
    window.setTimeout(() => setCopiedPayoutKey((current) => (current === key ? "" : current)), 1800);
  }

  async function markPaid(payout: Payout) {
    if (!activePlayer || activePlayer.id !== payout.from) return;
    await withRoomMutation((room) => markSettlementPaid(room.slug, room.passwordHash, payout.from, payout.to, payout.amount));
  }

  async function markUnpaid(settlement: Settlement) {
    if (activePlayerId !== settlement.from) return;
    await withRoomMutation((room) => cancelSettlementPaid(room.slug, room.passwordHash, settlement.id, activePlayerId));
  }

  async function confirmReceived(settlement: Settlement) {
    if (activePlayerId === settlement.from) return;
    if (!canManage && activePlayerId !== settlement.to) return;
    await withRoomMutation((room) => confirmSettlementReceived(room.slug, room.passwordHash, adminHash, settlement.id, activePlayerId === settlement.to ? activePlayerId : null));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <button className="brand-button" type="button" onClick={() => setCurrentPage("home")}>
          <Home size={18} /> Doekoe
        </button>
        <nav className="page-nav" aria-label="Primary">
          <button className={currentPage === "home" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("home")}>
            Home
          </button>
          <button className={currentPage === "users" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("users")} disabled={roomLocked || !canManage}>
            Users
          </button>
          <button className={currentPage === "matches" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("matches")} disabled={roomLocked}>
            Matches & payouts
          </button>
          <button className={currentPage === "leaderboard" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("leaderboard")} disabled={roomLocked}>
            Leaderboard
          </button>
          {activePlayerObligedPayouts.length > 0 && (
            <button className="notification-button" type="button" onClick={() => setCurrentPage("matches")} aria-label={`${activePlayerObligedPayouts.length} obliged payment${activePlayerObligedPayouts.length === 1 ? "" : "s"}`}>
              <Bell size={18} />
              <span>{activePlayerObligedPayouts.length}</span>
            </button>
          )}
        </nav>
      </header>

      {roomError && <p className="error-text page-error">{roomError}</p>}

      {currentPage === "home" && (
        <>
          <section className="hero home-hero">
            <div>
              <p className="eyebrow">Doekoe manager</p>
              <h1>Track matches. Pay with a QR.</h1>
              <p className="hero-copy">Join a shared room, log in as your player, and instantly see what you owe. Payments from {currency.format(MIN_PAYOUT)} are marked PAY NOW.</p>
            </div>
            <div className="hero-card">
              <span>{activeRoom ? "Shared room" : "Status"}</span>
              <strong>{activeRoom ? activeRoom.slug : "Locked"}</strong>
              <span>{syncStatus}</span>
              {!roomLocked && <span>{data.matches.length} matches tracked · {activePlayer ? activePlayer.name : "No player login"}</span>}
            </div>
          </section>

          <section className="home-grid">
            <section className="panel room-panel home-panel">
              <div>
                <p className="eyebrow">Shared room</p>
                <h2>{activeRoom ? "Connected" : "Enter room"}</h2>
                <p className="helper-text">The database is the source of truth. Local storage only remembers this session.</p>
              </div>

              {activeRoom ? (
                <button className="secondary-button" type="button" onClick={leaveRoom}>
                  <Cloud size={18} /> Leave room
                </button>
              ) : (
                <form className="room-form stacked-form" onSubmit={connectRoom}>
                  <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Room name, e.g. friday-games" />
                  <input value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} placeholder="Room password" type="password" />
                  <button type="submit" disabled={isJoiningRoom}>
                    <Cloud size={18} /> {isJoiningRoom ? "Joining" : "Join room"}
                  </button>
                </form>
              )}
            </section>

            <section className="panel admin-panel home-panel">
              <div>
                <p className="eyebrow">Admin</p>
                <h2>{canManage ? "Editing unlocked" : "Enter code"}</h2>
                <p className="helper-text">Admins manage users, IBANs, PINs, matches, and can confirm any payment.</p>
                {adminError && <p className="error-text">{adminError}</p>}
              </div>

              {canManage ? (
                <button className="secondary-button" type="button" onClick={lockAdmin}>
                  Lock editing
                </button>
              ) : (
                <form className="admin-form" onSubmit={unlockAdmin}>
                  <input value={adminCode} onChange={(event) => setAdminCode(event.target.value)} placeholder="Admin code" type="password" />
                  <button type="submit">Unlock</button>
                </form>
              )}
            </section>

            {activeRoom && (
              <section className="panel player-login-panel home-panel">
                <div>
                  <p className="eyebrow">Player login</p>
                  <h2>{activePlayer ? `Logged in as ${activePlayer.name}` : "Select yourself"}</h2>
                  <p className="helper-text">Players can mark their own outgoing payments as paid. Receivers can confirm incoming payments.</p>
                  {playerLoginError && <p className="error-text">{playerLoginError}</p>}
                </div>
                {activePlayer ? (
                  <button className="secondary-button" type="button" onClick={() => setActivePlayerId("")}>Switch player</button>
                ) : (
                  <form className="admin-form" onSubmit={loginAsPlayer}>
                    <select value={playerLoginId} onChange={(event) => setPlayerLoginId(event.target.value)} aria-label="Player">
                      <option value="">Choose player</option>
                      {data.players.map((player) => (
                        <option key={player.id} value={player.id}>
                          {player.name}
                        </option>
                      ))}
                    </select>
                    <input value={playerPin} onChange={(event) => setPlayerPin(event.target.value)} placeholder="Player PIN" type="password" />
                    <button type="submit">Login</button>
                  </form>
                )}
              </section>
            )}
          </section>

          <section className="panel steps-panel">
            <p className="eyebrow">How it works</p>
            <div className="steps-grid">
              <article><strong>1. Join room</strong><span>Everyone uses the same room password.</span></article>
              <article><strong>2. Login as player</strong><span>Your PIN unlocks your own payment actions.</span></article>
              <article><strong>3. Add matches</strong><span>Doekoe calculates live balances from database records.</span></article>
              <article><strong>4. Scan QR</strong><span>Payments use SEPA bank transfer QR codes, no iDEAL transaction fee.</span></article>
            </div>
          </section>
        </>
      )}

      {currentPage === "users" && canManage && (
        <section className="panel page-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Users</p>
              <h2>Squad</h2>
              <p className="helper-text">Admin-only player, IBAN, account name, and PIN management.</p>
            </div>
            <div className="player-count"><Users size={17} />{data.players.length}</div>
          </div>

          {!canManage ? (
            <div className="empty-state">Enter the admin code on Home to manage users.</div>
          ) : (
            <>
              <form className="user-create-grid" onSubmit={addPlayer}>
                <input value={newPlayerName} onChange={(event) => setNewPlayerName(event.target.value)} placeholder="Player name" />
                <input value={newPlayerAccountName} onChange={(event) => setNewPlayerAccountName(event.target.value)} placeholder="Account holder" />
                <input value={newPlayerIban} onChange={(event) => setNewPlayerIban(event.target.value)} placeholder="IBAN" />
                <input value={newPlayerPin} onChange={(event) => setNewPlayerPin(event.target.value)} placeholder="Player PIN" type="password" />
                <button type="submit"><Plus size={18} /> Add</button>
              </form>

              <div className="players-list compact-list">
                {data.players.length === 0 ? (
                  <div className="empty-state">Add your friends before creating a match.</div>
                ) : (
                  data.players.map((player) => {
                    const totals = playerTotals.get(player.id) ?? { incoming: 0, outgoing: 0 };
                    return (
                      <article className="player-row user-row" key={player.id}>
                        <input className="name-input" value={player.name} onFocus={() => { isEditingRef.current = true; }} onChange={(event) => editPlayerLocal(player.id, { name: event.target.value })} onBlur={() => void finishPlayerEdit(player)} aria-label="Player name" />
                        <input value={player.accountName ?? ""} onFocus={() => { isEditingRef.current = true; }} onChange={(event) => editPlayerLocal(player.id, { accountName: event.target.value })} onBlur={() => void finishPlayerEdit(player)} placeholder="Account holder" />
                        <input value={player.iban ?? ""} onFocus={() => { isEditingRef.current = true; }} onChange={(event) => editPlayerLocal(player.id, { iban: event.target.value })} onBlur={() => void finishPlayerEdit(player)} placeholder="IBAN" />
                        <input value={pinDraftByPlayer[player.id] ?? ""} onChange={(event) => setPinDraftByPlayer((current) => ({ ...current, [player.id]: event.target.value }))} placeholder="New PIN" type="password" />
                        <button type="button" onClick={() => void resetPlayerPin(player)} disabled={!pinDraftByPlayer[player.id]}>Set PIN</button>
                        <div className="balance-split" aria-label={`${player.name} balance`}>
                          <strong className="balance positive">+{currency.format(totals.incoming)}</strong>
                          <strong className="balance negative">-{currency.format(totals.outgoing)}</strong>
                        </div>
                        {canManage && <button className="icon-button" type="button" onClick={() => void removePlayer(player.id)} aria-label={`Remove ${player.name}`}><Trash2 size={18} /></button>}
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      )}

      {currentPage === "matches" && (
        <section className="grid advanced-grid page-grid">
          <div className="left-stack">
            {activePlayer && payouts.some((payout) => payout.from === activePlayer.id) && (
              <section className="panel urgent-panel">
                <p className="eyebrow">Your payments</p>
                {payouts.filter((payout) => payout.from === activePlayer.id).map((payout) => (
                  <h2 key={`${payout.from}->${payout.to}`}>YOU OWE {playerNameById.get(payout.to)?.toUpperCase()} {currency.format(payout.amount)}. PAY NOW.</h2>
                ))}
              </section>
            )}

            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">Match</p><h2>Add result</h2></div>
                <div className="player-count"><Swords size={17} />{winnerIds.length}v{loserIds.length}</div>
              </div>

              <form onSubmit={addMatch}>
                <label className="field-label" htmlFor="stake">Stake per payer to winner</label>
                <div className="money-input-wrap stake-field"><span>EUR</span><input id="stake" className="money-input" type="number" min="0" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} /></div>
                <div className="pick-columns">
                  <div><p className="field-label">Winners</p><div className="chip-grid">{data.players.map((player) => <button className={winnerIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleWinner(player.id)}><Trophy size={15} /> {player.name}</button>)}</div></div>
                  <div><p className="field-label">Losers</p><div className="chip-grid">{data.players.map((player) => <button className={loserIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleLoser(player.id)}>{player.name}</button>)}</div></div>
                </div>

                {winnerIds.length > 0 && loserIds.length > 0 && (
                  <div className="receive-panel">
                    <p className="field-label">Who does each winner receive from?</p>
                    <p className="helper-text">Leave empty to receive from all losers. Select specific losers if the payout was split differently.</p>
                    {winnerIds.map((winnerId) => <div className="receiver-row" key={winnerId}><strong>{playerNameById.get(winnerId)}</strong><div className="chip-grid small-chips">{loserIds.map((loserId) => <button className={(receiveFromByWinner[winnerId]?.includes(loserId) ?? false) ? "chip selected" : "chip"} key={loserId} type="button" onClick={() => toggleReceiverPayer(winnerId, loserId)}>{playerNameById.get(loserId)}</button>)}</div></div>)}
                  </div>
                )}

                <button className="full-button" type="submit" disabled={!canAddMatch}><Plus size={18} /> Add match</button>
              </form>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">Payouts</p><h2>Payments</h2><p className="helper-text">Confirmed received payments reduce the official balance. Marked payments stay pending until the receiver or admin confirms.</p></div>
                <span className="status balanced">{obliged.length} obliged</span>
              </div>
              <div className="payout-list">
                {payouts.length === 0 ? <div className="empty-state">No outstanding payments yet.</div> : payouts.map((payout) => {
                  const key = `${payout.from}->${payout.to}`;
                  const receiver = playerById.get(payout.to);
                  const pendingForPair = pendingSettlements.find((settlement) => settlement.from === payout.from && settlement.to === payout.to);
                  return (
                    <article className={payout.amount >= MIN_PAYOUT ? "payout-card obliged" : "payout-card"} key={key}>
                      <div className="payout-mainline"><div><strong>{activePlayerId === payout.from ? "YOU" : playerNameById.get(payout.from)} OWE {playerNameById.get(payout.to)} {currency.format(payout.amount)}</strong><span>{playerNameById.get(payout.from)} please pay me {currency.format(payout.amount)}</span></div>{payout.amount >= MIN_PAYOUT && <span className="pay-now">PAY NOW!</span>}</div>
                      {receiver?.iban ? <PaymentQr value={buildSepaQrValue(receiver, playerNameById.get(payout.from) ?? "Player", payout.amount)} /> : <div className="empty-state compact-empty">Receiver needs an IBAN before QR can be generated.</div>}
                      <div className="payout-actions">
                        <button className="copy-button" type="button" onClick={() => void copyPaymentDetails(payout)} disabled={!receiver?.iban}><Copy size={16} /> {copiedPayoutKey === key ? "Copied" : "Copy details"}</button>
                        {pendingForPair && activePlayerId === payout.from ? (
                          <button type="button" onClick={() => void markUnpaid(pendingForPair)}>Mark unpaid</button>
                        ) : (
                          <button type="button" onClick={() => void markPaid(payout)} disabled={activePlayerId !== payout.from}> <QrCode size={16} /> Mark as paid</button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Pending</p><h2>Awaiting confirmation</h2></div></div>
              <div className="match-list">
                {pendingSettlements.length === 0 ? <div className="empty-state">No payments are waiting for confirmation.</div> : pendingSettlements.map((settlement) => (
                  <article className="pending-row" key={settlement.id}>
                    <div><strong>{playerNameById.get(settlement.from)} marked {currency.format(settlement.amount)} as paid</strong><span>to {playerNameById.get(settlement.to)}</span></div>
                    <button className="confirm-button" type="button" onClick={() => void confirmReceived(settlement)} disabled={activePlayerId === settlement.from || (!canManage && activePlayerId !== settlement.to)}>Confirm payment</button>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">History</p><h2>Matches</h2></div><span className="status">Total in play {currency.format(totalInPlay)}</span></div>
              <div className="match-list">
                {data.matches.length === 0 ? <div className="empty-state">No matches yet. Add a result to calculate payouts.</div> : data.matches.map((match) => <article className="match-row" key={match.id}><div><strong>{match.winnerIds.map((id) => playerNameById.get(id)).join(", ")}</strong><span>beat {match.loserIds.map((id) => playerNameById.get(id)).join(", ")}</span><small>{currency.format(match.stake)} per payer-to-winner</small></div>{canManage && <button className="icon-button" type="button" onClick={() => void deleteMatch(match.id)} aria-label="Delete match"><Trash2 size={18} /></button>}</article>)}
              </div>
            </section>
          </div>
        </section>
      )}

      {currentPage === "leaderboard" && (
        <section className="panel page-panel leaderboard-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Leaderboard</p>
              <h2>Who is up and down</h2>
              <p className="helper-text">Ranked by current net balance after confirmed payments.</p>
            </div>
            <span className="status balanced">{data.players.length} players</span>
          </div>

          <div className="leaderboard-list">
            {leaderboard.length === 0 ? (
              <div className="empty-state">Add players and matches to build the leaderboard.</div>
            ) : (
              leaderboard.map((entry, index) => (
                <article className={entry.net >= 0 ? "leaderboard-row positive-row" : "leaderboard-row negative-row"} key={entry.player.id}>
                  <span className="leaderboard-rank">#{index + 1}</span>
                  <div>
                    <strong>{entry.player.name}</strong>
                    <span>+{currency.format(entry.incoming)} / -{currency.format(entry.outgoing)}</span>
                  </div>
                  <strong className={entry.net >= 0 ? "leaderboard-net positive" : "leaderboard-net negative"}>{entry.net >= 0 ? "+" : "-"}{currency.format(Math.abs(entry.net))}</strong>
                </article>
              ))
            )}
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
