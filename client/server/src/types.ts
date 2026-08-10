export type Theme = 'dark' | 'light';

export type User = {
  id: string;
  email: string;
  emailVerified: number;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  bio: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Chat = { id: string; createdAt: string };
export type Message = { id: string; chatId: string; senderId: string; text: string; createdAt: string; updatedAt: string };
export type Session = { id: string; userId: string; device: string; ip: string; createdAt: string; lastSeenAt: string; revokedAt: string | null };
export type Favorite = { id: string; userId: string; text: string; createdAt: string; updatedAt: string };
