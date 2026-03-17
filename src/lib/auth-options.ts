import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET || (process.env.NODE_ENV === 'development' ? 'dev-secret-change-in-production' : undefined),
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        pin: { label: 'PIN', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.pin) return null

        try {
          const user = await db.user.findUnique({
            where: { email: credentials.email.toLowerCase().trim() },
            include: { role: true },
          })

          console.log('Login attempt:', credentials.email)
          console.log('User found:', user ? 'yes' : 'no')
          console.log('User active:', user?.active)

          if (!user || !user.active) return null

          // Try both hash formats
          const hash2b = user.pinHash.replace('$2a$', '$2b$')
          const hash2a = user.pinHash.replace('$2b$', '$2a$')

          const valid2b = await bcrypt.compare(credentials.pin, hash2b)
          const valid2a = await bcrypt.compare(credentials.pin, hash2a)
          const validOriginal = await bcrypt.compare(credentials.pin, user.pinHash)

          console.log('Valid (2b):', valid2b)
          console.log('Valid (2a):', valid2a)
          console.log('Valid (original):', validOriginal)

          const valid = valid2b || valid2a || validOriginal
          if (!valid) return null

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role.roleName,
            permissions: user.role.permissions,
            machineAccess: user.machineAccess,
          }
        } catch (error) {
          console.error('Auth error:', error)
          return null
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role
        token.permissions = user.permissions
        token.machineAccess = user.machineAccess
      }
      return token
    },
    async session({ session, token }) {
      if (session?.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.permissions = token.permissions
        session.user.machineAccess = token.machineAccess as string[]
      }
      return session
    },
  },
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
}
