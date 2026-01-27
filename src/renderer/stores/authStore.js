import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Authentication store with persistence
 */
export const useAuthStore = create(
  persist(
    (set, get) => ({
      // Auth state
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      
      // Roles: 'admin', 'forensic_expert', 'viewer'
      
      // Check authentication status
      checkAuth: async () => {
        const { token, user } = get();
        
        if (token && user) {
          // Verify token with backend
          try {
            const response = await fetch('http://localhost:3001/api/auth/verify', {
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            
            if (response.ok) {
              set({ isAuthenticated: true });
            } else {
              get().logout();
            }
          } catch (error) {
            // Offline mode - trust local token
            set({ isAuthenticated: true });
          }
        }
      },
      
      // Login
      login: async (credentials) => {
        set({ isLoading: true, error: null });
        
        try {
          const response = await fetch('http://localhost:3001/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(credentials)
          });
          
          if (!response.ok) {
            throw new Error('Invalid credentials');
          }
          
          const data = await response.json();
          
          set({
            user: data.user,
            token: data.token,
            isAuthenticated: true,
            isLoading: false
          });
          
          return true;
        } catch (error) {
          set({
            error: error.message,
            isLoading: false
          });
          return false;
        }
      },
      
      // Logout
      logout: () => {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          error: null
        });
      },
      
      // Update user profile
      updateProfile: (updates) => {
        set(state => ({
          user: { ...state.user, ...updates }
        }));
      },
      
      // Check if user has permission
      hasPermission: (permission) => {
        const { user } = get();
        if (!user) return false;
        
        const rolePermissions = {
          admin: ['read', 'write', 'delete', 'export', 'manage_users', 'view_audit'],
          forensic_expert: ['read', 'write', 'export', 'view_audit'],
          viewer: ['read']
        };
        
        return rolePermissions[user.role]?.includes(permission) || false;
      },
      
      // Check if user is admin
      isAdmin: () => {
        const { user } = get();
        return user?.role === 'admin';
      },
      
      // Demo login for development
      demoLogin: () => {
        set({
          user: {
            id: 'demo-user',
            username: 'forensic_expert',
            name: 'Dr. Demo User',
            email: 'demo@reface.local',
            role: 'forensic_expert',
            department: 'Forensic Science Division'
          },
          token: 'demo-token-' + Date.now(),
          isAuthenticated: true,
          isLoading: false
        });
      }
    }),
    {
      name: 'reface-auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token
      })
    }
  )
);
