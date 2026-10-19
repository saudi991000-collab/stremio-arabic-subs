import { createHmac, timingSafeEqual } from "node:crypto";

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function signature(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSubtitleToken(payload, secret, now = Date.now()) {
  const body = encode(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + 604800 }));
  return `${body}.${signature(body, secret)}`;
}

export function verifySubtitleToken(token, secret, now = Date.now()) {
  const [body, supplied] = String(token).split(".");
  if (!body || !supplied) throw new Error("Invalid subtitle token");
  const expected = signature(body, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid subtitle token signature");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(now / 1000)) throw new Error("Subtitle token expired");
  return payload;
}
