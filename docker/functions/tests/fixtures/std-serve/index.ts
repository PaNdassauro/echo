// Usa o serve do deno.land/std (remapeado para shim/std_server.ts no deno.json do runtime).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(() => Response.json({ via: "std" }));
