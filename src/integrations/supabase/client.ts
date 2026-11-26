// Cliente Supabase do front. Escrito à mão; só os tipos (./types) são gerados (npm run gen:types).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { getRuntimeConfig } from '@/lib/runtimeConfig';

// Endereço e chave vêm do /config.js (ou das VITE_* em desenvolvimento): veja runtimeConfig.ts.
// Sem a chave anon o getRuntimeConfig lança uma RuntimeConfigError com a causa.
const { supabaseUrl, supabaseAnonKey } = getRuntimeConfig();

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});