import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Copy, Home, Plus, Swords, Trash2, Trophy, Users } from "lucide-react";

import { isSupabaseConfigured, joinRoom, saveRoom } from "./supabase";
import type { AppData, Match, Player } from "./types";

type Payout = {
  from: string;
  to: string;
  amount: number;
};

type PlayerTotals = {
  incoming: number;
  outgoing: number;
};

type Page = "home" | "users" | "matches";

const STORAGE_KEY = "doekoe.advanced.v1";
const ROOM_SESSION_KEY = "doekoe.activeRoom.v1";
const ADMIN_SESSION_KEY = "doekoe.admin.v1";
const MIN_PAYOUT = 10;
const ADMIN_CODE = import.meta.env.VITE_ADMIN_CODE?.trim() ?? "";
const PAYMENT_REQUEST_URL_TEMPLATE = import.meta.env.VITE_PAYMENT_REQUEST_URL_TEMPLATE?.trim() ?? "";
const EMPTY_DATA: AppData = { players: [], matches: [], deletedPlayerIds: [], deletedMatchIds: [] };

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

function normalizeData(value: AppData | null | undefined): AppData {
  return {
    players: value?.players ?? [],
    matches: value?.matches ?? [],
    deletedPlayerIds: value?.deletedPlayerIds ?? [],
    deletedMatchIds: value?.deletedMatchIds ?? [],
  };
}

function roomKey(room: { slug: string; passwordHash: string } | null) {
  return room ? `${room.slug}:${room.passwordHash}` : "";
}

function fillPaymentRequestTemplate(template: string, payout: Payout, playerNameById: Map<string, string>) {
  const payer = playerNameById.get(payout.from) ?? "Player";
  const receiver = playerNameById.get(payout.to) ?? "me";
  const amount = payout.amount.toFixed(2);
  const description = `${payer} please pay me ${currency.format(payout.amount)}`;
  const replacements: Record<string, string> = { amount, description, payer, receiver };

  return template.replace(/\{(amount|description|payer|receiver)\}/g, (_, key: string) => encodeURIComponent(replacements[key]));
}

async function hashPassword(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function calculateBalances(players: Player[], matches: Match[]) {
  const playerIds = new Set(players.map((player) => player.id));
  const pairTotals = new Map<string, Payout>();

  for (const match of matches) {
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

  const settledPairs = new Map<string, number>();
  for (const payout of pairTotals.values()) {
    const [first, second] = [payout.from, payout.to].sort();
    const key = `${first}<->${second}`;
    const signedAmount = payout.from === first ? payout.amount : -payout.amount;
    settledPairs.set(key, roundMoney((settledPairs.get(key) ?? 0) + signedAmount));
  }

  const payouts = [...settledPairs.entries()]
    .flatMap(([key, amount]) => {
      if (amount === 0) return [];
      const [first, second] = key.split("<->");
      return [
        {
          from: amount > 0 ? first : second,
          to: amount > 0 ? second : first,
          amount: Math.abs(amount),
        },
      ];
    })
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
    optional: payouts.filter((payout) => payout.amount > 0 && payout.amount < MIN_PAYOUT),
  };
}

function App() {
  const [data, setData] = useState<AppData>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? normalizeData(JSON.parse(saved) as AppData) : EMPTY_DATA;
    } catch {
      return EMPTY_DATA;
    }
  });
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
  const [roomError, setRoomError] = useState("");
  const [syncStatus, setSyncStatus] = useState(isSupabaseConfigured ? "Local until you join a room" : "Add Supabase env vars to enable shared rooms");
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const skipNextSaveRef = useRef(false);
  const hasLocalChangesRef = useRef(false);
  const isSavingRef = useRef(false);
  const [syncedRoomKey, setSyncedRoomKey] = useState("");
  const [adminCode, setAdminCode] = useState("");
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem(ADMIN_SESSION_KEY) === "true");
  const [adminError, setAdminError] = useState("");
  const [newPlayerName, setNewPlayerName] = useState("");
  const [stake, setStake] = useState("10");
  const [winnerIds, setWinnerIds] = useState<string[]>([]);
  const [loserIds, setLoserIds] = useState<string[]>([]);
  const [receiveFromByWinner, setReceiveFromByWinner] = useState<Record<string, string[]>>({});
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [copiedPayoutKey, setCopiedPayoutKey] = useState("");

  const activeRoomKey = roomKey(activeRoom);

  function updateData(updater: (current: AppData) => AppData) {
    hasLocalChangesRef.current = true;
    setData((current) => normalizeData(updater(normalizeData(current))));
  }

  async function copyPaymentRequest(payout: Payout) {
    if (!PAYMENT_REQUEST_URL_TEMPLATE) return;

    const link = fillPaymentRequestTemplate(PAYMENT_REQUEST_URL_TEMPLATE, payout, playerNameById);
    const key = `${payout.from}->${payout.to}`;
    await navigator.clipboard.writeText(link);
    setCopiedPayoutKey(key);
    window.setTimeout(() => setCopiedPayoutKey((current) => (current === key ? "" : current)), 1800);
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeData(data)));
  }, [data]);

  useEffect(() => {
    if (!activeRoom) {
      localStorage.removeItem(ROOM_SESSION_KEY);
      setSyncedRoomKey("");
      return;
    }

    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(activeRoom));
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom || !isSupabaseConfigured) return;

    let cancelled = false;
    const room = activeRoom;

    async function loadActiveRoom() {
      if (hasLocalChangesRef.current || isSavingRef.current) return;

      try {
        setSyncStatus("Loading shared room...");
        const remoteData = await joinRoom(room.slug, room.passwordHash);
        if (cancelled) return;
        skipNextSaveRef.current = true;
        setData(normalizeData(remoteData));
        setSyncedRoomKey(roomKey(room));
        setSyncStatus("Shared room connected");
      } catch (error) {
        if (cancelled) return;
        setRoomError(error instanceof Error ? error.message : "Could not load room");
        setSyncStatus("Room sync failed");
      }
    }

    void loadActiveRoom();
    const intervalId = window.setInterval(loadActiveRoom, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom || !isSupabaseConfigured || syncedRoomKey !== activeRoomKey) return;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        setSyncStatus("Saving shared room...");
        isSavingRef.current = true;
        await saveRoom(activeRoom.slug, activeRoom.passwordHash, normalizeData(data));
        hasLocalChangesRef.current = false;
        setSyncStatus("Saved to shared room");
      } catch (error) {
        setRoomError(error instanceof Error ? error.message : "Could not save room");
        setSyncStatus("Room save failed");
      } finally {
        isSavingRef.current = false;
      }
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [activeRoom, activeRoomKey, data, syncedRoomKey]);

  const canManage = isAdmin && ADMIN_CODE.length > 0;
  const playerNameById = useMemo(() => new Map(data.players.map((player) => [player.id, player.name])), [data.players]);
  const { playerTotals, payouts, obliged } = useMemo(() => calculateBalances(data.players, data.matches), [data.players, data.matches]);
  const totalInPlay = data.matches.reduce((sum, match) => {
    const matchPayers = match.winnerIds.reduce((count, winnerId) => count + (match.receiveFromByWinner[winnerId]?.length || match.loserIds.length), 0);
    return roundMoney(sum + match.stake * matchPayers);
  }, 0);
  const stakeAmount = Number(stake);
  const canAddMatch = stakeAmount > 0 && winnerIds.length > 0 && loserIds.length > 0;
  const roomLocked = isSupabaseConfigured && !activeRoom;

  useEffect(() => {
    if (roomLocked && currentPage !== "home") setCurrentPage("home");
  }, [currentPage, roomLocked]);

  function unlockAdmin(event: FormEvent) {
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

    localStorage.setItem(ADMIN_SESSION_KEY, "true");
    setIsAdmin(true);
    setAdminCode("");
  }

  function lockAdmin() {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    setIsAdmin(false);
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
      const remoteData = await joinRoom(slug, passwordHash);
      skipNextSaveRef.current = true;
      setData(normalizeData(remoteData));
      setActiveRoom({ slug, passwordHash });
      setSyncedRoomKey(roomKey({ slug, passwordHash }));
      setRoomName("");
      setRoomPassword("");
      setSyncStatus("Shared room connected");
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not join room");
      setSyncStatus("Room join failed");
    } finally {
      setIsJoiningRoom(false);
    }
  }

  function leaveRoom() {
    setActiveRoom(null);
    setSyncedRoomKey("");
    setRoomError("");
    setSyncStatus(isSupabaseConfigured ? "Local until you join a room" : "Add Supabase env vars to enable shared rooms");
  }

  function addPlayer(event: FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    const name = newPlayerName.trim();
    if (!name) return;

    updateData((current) => ({ ...current, players: [...current.players, { id: createId(), name }] }));
    setNewPlayerName("");
  }

  function removePlayer(id: string) {
    if (!canManage) return;

    updateData((current) => {
      const updatedMatches = current.matches.map((match) => ({
        ...match,
        winnerIds: match.winnerIds.filter((winnerId) => winnerId !== id),
        loserIds: match.loserIds.filter((loserId) => loserId !== id),
        receiveFromByWinner: Object.fromEntries(
          Object.entries(match.receiveFromByWinner)
            .filter(([winnerId]) => winnerId !== id)
            .map(([winnerId, payerIds]) => [winnerId, payerIds.filter((payerId) => payerId !== id)]),
        ),
      }));
      const remainingMatches = updatedMatches.filter((match) => match.winnerIds.length > 0 && match.loserIds.length > 0);
      const removedMatchIds = updatedMatches.filter((match) => match.winnerIds.length === 0 || match.loserIds.length === 0).map((match) => match.id);

      return {
        players: current.players.filter((player) => player.id !== id),
        matches: remainingMatches,
        deletedPlayerIds: [...new Set([...(current.deletedPlayerIds ?? []), id])],
        deletedMatchIds: [...new Set([...(current.deletedMatchIds ?? []), ...removedMatchIds])],
      };
    });
    setWinnerIds((current) => current.filter((playerId) => playerId !== id));
    setLoserIds((current) => current.filter((playerId) => playerId !== id));
    setReceiveFromByWinner((current) =>
      Object.fromEntries(
        Object.entries(current)
          .filter(([winnerId]) => winnerId !== id)
          .map(([winnerId, payerIds]) => [winnerId, payerIds.filter((payerId) => payerId !== id)]),
      ),
    );
  }

  function updatePlayer(id: string, name: string) {
    if (!canManage) return;

    updateData((current) => ({ ...current, players: current.players.map((player) => (player.id === id ? { ...player, name } : player)) }));
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

  function addMatch(event: FormEvent) {
    event.preventDefault();
    if (!canAddMatch) return;

    const cleanedReceiveMap = Object.fromEntries(
      winnerIds.map((winnerId) => {
        const chosenPayers = receiveFromByWinner[winnerId]?.filter((payerId) => loserIds.includes(payerId)) ?? [];
        return [winnerId, chosenPayers.length ? chosenPayers : loserIds];
      }),
    );

    updateData((current) => ({
      ...current,
      matches: [
        {
          id: createId(),
          createdAt: Date.now(),
          stake: roundMoney(stakeAmount),
          winnerIds,
          loserIds,
          receiveFromByWinner: cleanedReceiveMap,
        },
        ...current.matches,
      ],
    }));
    setWinnerIds([]);
    setLoserIds([]);
    setReceiveFromByWinner({});
  }

  function deleteMatch(id: string) {
    if (!canManage) return;

    updateData((current) => ({
      ...current,
      matches: current.matches.filter((match) => match.id !== id),
      deletedMatchIds: [...new Set([...(current.deletedMatchIds ?? []), id])],
    }));
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
          <button className={currentPage === "users" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("users")} disabled={roomLocked}>
            Users
          </button>
          <button className={currentPage === "matches" ? "nav-button active" : "nav-button"} type="button" onClick={() => setCurrentPage("matches")} disabled={roomLocked}>
            Matches & payouts
          </button>
        </nav>
      </header>

      {currentPage === "home" && (
        <>
          <section className="hero home-hero">
            <div>
              <p className="eyebrow">Doekoe manager</p>
              <h1>Track matches. Settle fast.</h1>
              <p className="hero-copy">
                Join a shared room, add players, record winners and losers, and Doekoe calculates who pays who. Payments from {currency.format(MIN_PAYOUT)} are marked as obliged with PAY NOW.
              </p>
            </div>
            <div className="hero-card">
              <span>{activeRoom ? "Shared room" : "Status"}</span>
              <strong>{activeRoom ? activeRoom.slug : "Locked"}</strong>
              <span>{syncStatus}</span>
              {!roomLocked && <span>{data.matches.length} matches tracked</span>}
            </div>
          </section>

          <section className="home-grid">
            <section className="panel room-panel home-panel">
              <div>
                <p className="eyebrow">Shared room</p>
                <h2>{activeRoom ? "Connected" : "Enter room"}</h2>
                <p className="helper-text">Use the same room name and password on every browser so everyone sees the same data.</p>
                {roomError && <p className="error-text">{roomError}</p>}
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
                <p className="helper-text">The Users page, player edits, and match deletion require the admin code.</p>
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
          </section>

          <section className="panel steps-panel">
            <p className="eyebrow">How it works</p>
            <div className="steps-grid">
              <article>
                <strong>1. Join a room</strong>
                <span>Everyone uses the same room name and password.</span>
              </article>
              <article>
                <strong>2. Add users</strong>
                <span>Admins manage the squad on the Users page.</span>
              </article>
              <article>
                <strong>3. Add matches</strong>
                <span>Select winners, losers, and who each winner receives from.</span>
              </article>
              <article>
                <strong>4. Pay out</strong>
                <span>Open Matches & payouts to copy iDEAL/payment request links.</span>
              </article>
            </div>
          </section>
        </>
      )}

      {currentPage === "users" && (
        <section className="panel page-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Users</p>
              <h2>Squad</h2>
              <p className="helper-text">Admin-only player management.</p>
            </div>
            <div className="player-count">
              <Users size={17} />
              {data.players.length}
            </div>
          </div>

          {!canManage ? (
            <div className="empty-state">Enter the admin code on Home to manage users.</div>
          ) : (
            <>
              <form className="add-player" onSubmit={addPlayer}>
                <input value={newPlayerName} onChange={(event) => setNewPlayerName(event.target.value)} placeholder="Player name" />
                <button type="submit">
                  <Plus size={18} /> Add
                </button>
              </form>

              <div className="players-list compact-list">
                {data.players.length === 0 ? (
                  <div className="empty-state">Add your friends before creating a match.</div>
                ) : (
                  data.players.map((player) => {
                    const totals = playerTotals.get(player.id) ?? { incoming: 0, outgoing: 0 };
                    return (
                      <article className="player-row compact-row" key={player.id}>
                        <input className="name-input" value={player.name} onChange={(event) => updatePlayer(player.id, event.target.value)} aria-label="Player name" />
                        <div className="balance-split" aria-label={`${player.name} balance`}>
                          <strong className="balance positive">+{currency.format(totals.incoming)}</strong>
                          <strong className="balance negative">-{currency.format(totals.outgoing)}</strong>
                        </div>
                        <button className="icon-button" type="button" onClick={() => removePlayer(player.id)} aria-label={`Remove ${player.name}`}>
                          <Trash2 size={18} />
                        </button>
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
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Match</p>
                  <h2>Add result</h2>
                </div>
                <div className="player-count">
                  <Swords size={17} />
                  {winnerIds.length}v{loserIds.length}
                </div>
              </div>

              <form onSubmit={addMatch}>
                <label className="field-label" htmlFor="stake">
                  Stake per payer to winner
                </label>
                <div className="money-input-wrap stake-field">
                  <span>EUR</span>
                  <input id="stake" className="money-input" type="number" min="0" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} />
                </div>

                <div className="pick-columns">
                  <div>
                    <p className="field-label">Winners</p>
                    <div className="chip-grid">
                      {data.players.map((player) => (
                        <button className={winnerIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleWinner(player.id)}>
                          <Trophy size={15} /> {player.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="field-label">Losers</p>
                    <div className="chip-grid">
                      {data.players.map((player) => (
                        <button className={loserIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleLoser(player.id)}>
                          {player.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {winnerIds.length > 0 && loserIds.length > 0 && (
                  <div className="receive-panel">
                    <p className="field-label">Who does each winner receive from?</p>
                    <p className="helper-text">Leave empty to receive from all losers. Select specific losers if the payout was split differently.</p>
                    {winnerIds.map((winnerId) => (
                      <div className="receiver-row" key={winnerId}>
                        <strong>{playerNameById.get(winnerId)}</strong>
                        <div className="chip-grid small-chips">
                          {loserIds.map((loserId) => (
                            <button
                              className={(receiveFromByWinner[winnerId]?.includes(loserId) ?? false) ? "chip selected" : "chip"}
                              key={loserId}
                              type="button"
                              onClick={() => toggleReceiverPayer(winnerId, loserId)}
                            >
                              {playerNameById.get(loserId)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button className="full-button" type="submit" disabled={!canAddMatch}>
                  <Plus size={18} /> Add match
                </button>
              </form>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Payouts</p>
                  <h2>Obliged payments</h2>
                  <p className="helper-text">Payments from {currency.format(MIN_PAYOUT)} and up are marked PAY NOW.</p>
                </div>
                <span className="status balanced">{obliged.length} obliged</span>
              </div>

              <div className="payout-list">
                {payouts.length === 0 ? (
                  <div className="empty-state">No outstanding payments yet.</div>
                ) : (
                  payouts.map((payout) => {
                    const key = `${payout.from}->${payout.to}`;
                    const isObliged = payout.amount >= MIN_PAYOUT;
                    return (
                      <article className={isObliged ? "payout-row obliged" : "payout-row"} key={key}>
                        <div>
                          <strong>{playerNameById.get(payout.from)}</strong>
                          <span>pays {playerNameById.get(payout.to)}</span>
                        </div>
                        <div className="dashboard-amount">
                          {isObliged && <span className="pay-now">PAY NOW!</span>}
                          <strong>{currency.format(payout.amount)}</strong>
                        </div>
                        <button className="copy-button" type="button" onClick={() => void copyPaymentRequest(payout)} disabled={!PAYMENT_REQUEST_URL_TEMPLATE}>
                          <Copy size={16} /> {copiedPayoutKey === key ? "Copied" : "Copy iDEAL link"}
                        </button>
                      </article>
                    );
                  })
                )}
              </div>
              {!PAYMENT_REQUEST_URL_TEMPLATE && <p className="small-print">Set VITE_PAYMENT_REQUEST_URL_TEMPLATE to enable copyable payment request links.</p>}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">History</p>
                  <h2>Matches</h2>
                </div>
              </div>

              <div className="match-list">
                {data.matches.length === 0 ? (
                  <div className="empty-state">No matches yet. Add a result to calculate payouts.</div>
                ) : (
                  data.matches.map((match) => (
                    <article className="match-row" key={match.id}>
                      <div>
                        <strong>{match.winnerIds.map((id) => playerNameById.get(id)).join(", ")}</strong>
                        <span>beat {match.loserIds.map((id) => playerNameById.get(id)).join(", ")}</span>
                        <small>{currency.format(match.stake)} per payer-to-winner</small>
                      </div>
                      <button className="icon-button" type="button" onClick={() => deleteMatch(match.id)} aria-label="Delete match" disabled={!canManage}>
                        <Trash2 size={18} />
                      </button>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
