import { SignJWT, jwtVerify } from "jose";
import { getDb, seedDashboard } from "./db-server";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "matchprofit-dev-secret-change-in-production-2026"
);

const COOKIE_NAME = "mp_token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export interface JwtPayload {
  userId: string;
  email: string;
}

export async function createToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

export function setCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

export async function signupUser(email: string, password: string): Promise<{ ok: false; error: string } | { ok: true; userId: string }> {
  const db = getDb();
  const existing = db.query("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return { ok: false, error: "Email already registered" };
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });

  const userId = crypto.randomUUID();
  db.run("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", [
    userId,
    email.toLowerCase().trim(),
    passwordHash,
  ]);
  seedDashboard(userId);
  return { ok: true, userId };
}

export async function loginUser(email: string, password: string): Promise<{ ok: false; error: string } | { ok: true; userId: string; email: string }> {
  const db = getDb();
  const user = db
    .query("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as { id: string; email: string; password_hash: string } | undefined;

  if (!user) {
    return { ok: false, error: "Invalid email or password" };
  }

  const valid = await Bun.password.verify(password, user.password_hash);
  if (!valid) {
    return { ok: false, error: "Invalid email or password" };
  }

  return { ok: true, userId: user.id, email: user.email };
}

export function getTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export async function getUserFromRequest(request: Request): Promise<JwtPayload | null> {
  const token = getTokenFromRequest(request);
  if (!token) return null;
  return verifyToken(token);
}