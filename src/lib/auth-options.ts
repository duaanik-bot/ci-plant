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
          const rows = await db.$queryRawUnsafe<Array<{
            id: string
            name: string
            email: string
            pinHash: string
            active: boolean
            roleName: string
            permissions: unknown
            machineAccess: string[] | null
          }>>(
            `
              select
                u.id,
                u.name,
                u.email,
                u.pin_hash as "pinHash",
                u.active,
                r.role_name as "roleName",
                r.permissions,
                u.machine_access as "machineAccess"
              from users u
              join roles r on r.id = u.role_id
              where lower(u.email) = lower($1)
              limit 1
            `,
            credentials.email.toLowerCase().trim(),
          )

          const user = rows[0]
          if (!user || !user.active) return null

          const hash2b = user.pinHash.replace('$2a$', '$2b$')
          const hash2a = user.pinHash.replace('$2b$', '$2a$')
          const valid =
            (await bcrypt.compare(credentials.pin, hash2b)) ||
            (await bcrypt.compare(credentials.pin, hash2a)) ||
            (await bcrypt.compare(credentials.pin, user.pinHash))
          if (!valid) return null

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.roleName,
            permissions: user.permissions,
            machineAccess: user.machineAccess ?? [],
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
