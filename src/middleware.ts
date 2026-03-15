import { withAuth } from 'next-auth/middleware'

export default withAuth({
  pages: { signIn: '/login' },
})

// Protect all routes except login and NextAuth API
export const config = {
  matcher: ['/((?!login|oee|api/auth|_next/static|_next/image|favicon.ico).*)'],
}
