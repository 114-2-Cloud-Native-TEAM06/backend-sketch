import jwt from 'jsonwebtoken'

export default function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload   // { userId, username } 後續 route 直接用 req.user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Token expired or invalid' })
  }
}
