import { createBrowserRouter, Navigate, Outlet } from 'react-router'
import { PageSpinner, RouteError } from './components/RouteError'
import { Gallery } from './pages/Gallery'
import { NotFound } from './pages/NotFound'

// Admin screens are lazy-loaded so customers opening the gallery on their phone
// don't download the admin UI or the Supabase client.
export const router = createBrowserRouter([
  {
    // Root: shared error page + spinner while a lazy route loads on first visit
    element: <Outlet />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <PageSpinner />,
    children: [
      { path: '/', element: <Navigate to="/admin" replace /> },
      { path: '/login', lazy: () => import('./pages/Login').then((m) => ({ Component: m.Login })) },
      {
        path: '/admin',
        lazy: () => import('./admin').then((m) => ({ Component: m.AdminRoot })),
        children: [
          { index: true, lazy: () => import('./pages/Sessions').then((m) => ({ Component: m.Sessions })) },
          {
            path: 'sessions/:id',
            lazy: () => import('./pages/SessionDetail').then((m) => ({ Component: m.SessionDetail })),
          },
          { path: 'templates', lazy: () => import('./pages/Templates').then((m) => ({ Component: m.Templates })) },
        ],
      },
      // Public gallery the customer opens from the QR code
      { path: '/s/:slug', element: <Gallery /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
