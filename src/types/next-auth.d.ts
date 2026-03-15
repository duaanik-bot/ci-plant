import 'next-auth'
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface User {
    id: string
    role?: string
    permissions?: unknown
    machineAccess?: string[]
  }

  interface Session {
    user: DefaultSession['user'] & {
      id: string
      role?: string
      permissions?: unknown
      machineAccess?: string[]
    }
  }
}
