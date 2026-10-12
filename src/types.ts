export type Player = {
  id: string;
  name: string;
  iban?: string;
  accountName?: string;
};

export type Match = {
  id: string;
  createdAt: number;
  stake: number;
  winnerIds: string[];
  loserIds: string[];
  receiveFromByWinner: Record<string, string[]>;
};

export type SettlementStatus = "marked_paid" | "confirmed_received";

export type Settlement = {
  id: string;
  from: string;
  to: string;
  amount: number;
  status: SettlementStatus;
  markedBy: string;
  createdAt: number;
  confirmedBy?: string;
  confirmedAt?: number;
};

export type AppData = {
  players: Player[];
  matches: Match[];
  settlements: Settlement[];
};
