import { randomInt } from "node:crypto"
import { hash } from "bcryptjs"

// No look-alikes: 0/O/o, 1/l/I, 5/S, 2/Z, 8/B.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY34679"
const LENGTH = 14

export function generatePassword(): string {
  let out = ""
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

// Same cost as atlasagents-app's src/lib/password.ts, so login verifies them
// exactly like a real signup.
export function hashPassword(password: string): Promise<string> {
  return hash(password, 10)
}
