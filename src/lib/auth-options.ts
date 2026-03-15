import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

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
            where: { email: credentials.email },
            include: { role: true },
          })

          if (!user || !user.active) return null
          const valid = await bcrypt.compare(credentials.pin, user.pinHash)
          if (!valid) return null

          await db.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          })

          await createAuditLog({
            userId: user.id,
            action: 'LOGIN',
            tableName: 'users',
            recordId: user.id,
          })

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role.roleName,
            permissions: user.role.permissions,
            machineAccess: user.machineAccess,
          }
        } catch (e) {
          console.error('[Auth] authorize error:', e)
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
