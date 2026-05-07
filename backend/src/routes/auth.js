import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ─── POST /auth/register ────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, displayName, email, password } = req.body

  if (!username || !displayName || !email || !password) {
    return res.status(400).json({ error: 'username, displayName, email, password are required' })
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _ and - (3–32 chars)' })
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] }
    })
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Email'
      return res.status(409).json({ error: `${field} already taken` })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const user = await prisma.user.create({
      data: { username, displayName, email, password: hashedPassword },
      select: { id: true, username: true, displayName: true, email: true, createdAt: true }
    })

    const token = signToken(user)

    res.status(201).json({ user, token })
  } catch (err) {
    console.error('[register]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── POST /auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' })
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = signToken(user)

    res.json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
      token
    })
  } catch (err) {
    console.error('[login]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── 共用：簽發 JWT ─────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

export default router
