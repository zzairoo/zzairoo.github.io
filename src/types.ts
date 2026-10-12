export type Player = {
  id: string;
  name: string;
};

export type Match = {
  id: string;
  createdAt: number;
  stake: number;
  winnerIds: string[];
  loserIds: string[];
  receiveFromByWinner: Record<string, string[]>;
};

export type AppData = {
  players: Player[];
  matches: Match[];
  deletedPlayerIds?: string[];
  deletedMatchIds?: string[];
};
