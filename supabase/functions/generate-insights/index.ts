import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1'
import { createErrorResponse } from '../_shared/error-utils.ts';
import { anthropicComplete, isAnthropicKey } from '../_shared/ai-provider.ts';
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'no authorization header': 'Faça login para continuar.',
    'unauthorized': 'Você não tem permissão para acessar insights.',
    'missing orgid': 'Organização não selecionada.',
    'organization not found': 'Organização não encontrada.',
    'ai api key not configured': 'IA não configurada. Configure a chave de API nas configurações.',
    'ai provider error': 'Erro ao gerar insights. Tente novamente.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        console.log('--- Generate Insights Triggered ---')
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // 1. Get User from Auth Context (Request) -> to verify membership
        const authHeader = req.headers.get('Authorization')
        console.log('Auth Header present:', !!authHeader)

        if (!authHeader) {
            throw new Error('No authorization header')
        }

        const token = authHeader.replace('Bearer ', '')
        const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token)

        if (userError || !user) {
            console.error('Auth Error:', userError)
            throw new Error('Unauthorized')
        }
        console.log('User identified:', user.id)

        const requestBody = await req.json()
        console.log('Request Body:', requestBody)
        const { orgId, startDate, endDate, messages: history } = requestBody

        if (!orgId) throw new Error('Missing orgId')

        console.log(`Verifying membership for user ${user.id} in org ${orgId}`)
        // 2. Verify Membership & Role (Admin only)
        const { data: membership, error: memberError } = await supabaseClient
            .from('organization_members')
            .select('role')
            .eq('organization_id', orgId)
            .eq('user_id', user.id)
            .single()

        if (memberError || !membership || membership.role !== 'admin') {
            console.log('Membership check failed or not admin. Checking super admin status...')
            // Allow super admin bypass check if needed, but for now strict
            const { data: profile } = await supabaseClient.from('profiles').select('is_super_admin').eq('id', user.id).single();
            if (!profile?.is_super_admin) {
                console.error('Permission denied: not admin and not super_admin')
                throw new Error('Unauthorized: Only Admins can generate insights')
            }
            console.log('Super admin bypass granted')
        }
        console.log('Permission verified')

        // 3. Fetch Organization AI Settings
        console.log('Fetching Org Settings...')
        const { data: org, error: orgError } = await supabaseClient
            .from('organizations')
            .select('ai_insights_prompt, name')
            .eq('id', orgId)
            .single()

        if (orgError || !org) {
            console.error('Org Fetch Error:', orgError)
            throw new Error('Organization not found')
        }

        // Get encrypted key via secure RPC
        const { data: apiKey, error: keyError } = await supabaseClient
            .rpc('get_decrypted_ai_key', { p_org_id: orgId })

        if (keyError || !apiKey) {
            console.error('AI API Key fetch error or missing:', keyError)
            throw new Error('AI API Key not configured for this organization')
        }

        console.log('Org Settings fetched successfully')

        // 4. Determine context for AI
        let chatMessages = []

        if (history && history.length > 0) {
            console.log('Using conversation history...')
            chatMessages = history
        } else {
            console.log('Initial request - Fetching Analytics Data via RPCs...')
            // We can reuse the RPCs used in the frontend
            const [statsResult, volumeResult, templateResult] = await Promise.all([
                supabaseClient.rpc("get_advanced_analytics_stats", {
                    p_org_id: orgId,
                    p_start_date: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                    p_end_date: endDate || new Date().toISOString(),
                }),
                supabaseClient.rpc("get_analytics_daily_volume", {
                    p_org_id: orgId,
                    p_days: 30,
                    p_start_date: startDate,
                    p_end_date: endDate,
                }),
                supabaseClient.rpc("get_template_stats", {
                    p_org_id: orgId,
                    p_start_date: startDate,
                    p_end_date: endDate,
                })
            ]);

            if (statsResult.error) console.error('Stats RPC Error:', statsResult.error)
            if (volumeResult.error) console.error('Volume RPC Error:', volumeResult.error)
            if (templateResult.error) console.error('Template RPC Error:', templateResult.error)

            const analyticsContext = {
                summary: statsResult.data,
                daily_volume: volumeResult.data,
                top_templates: templateResult.data ? templateResult.data.slice(0, 5) : []
            };

            const prompt = org.ai_insights_prompt || "Analise os dados fornecidos e gere insights estratégicos.";

            chatMessages = [
                { role: 'user', content: `${prompt}\n\nData Context:\n${JSON.stringify(analyticsContext, null, 2)}` }
            ]
        }

        const systemMessage = `
You are an expert Data Analyst for a WhatsApp Communication Platform.
Your goal is to provide strategic insights based on the provided JSON data.
The user's organization name is "${org.name}".
Language: Portuguese (Brazil).
    `;


        // Provedor decidido pela chave da org: sk-ant-* → Anthropic; senão OpenAI
        let insightText: string;
        if (isAnthropicKey(apiKey)) {
            console.log('Calling Anthropic API...')
            insightText = await anthropicComplete({
                apiKey,
                system: systemMessage,
                messages: chatMessages,
                maxTokens: 16000,
            });
        } else {
            console.log('Calling OpenAI API...')
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'gpt-6-luna',
                    reasoning_effort: 'none',
                    messages: [
                        { role: 'system', content: systemMessage },
                        ...chatMessages
                    ],
                    temperature: 0.7,
                }),
            })

            const aiData = await response.json()
            console.log('OpenAI Response status:', response.status)

            if (aiData.error) {
                console.error('OpenAI API Error Detail:', aiData.error)
                throw new Error(`AI Provider Error: ${aiData.error.message}`)
            }
            insightText = aiData.choices?.[0]?.message?.content || "Não foi possível gerar insights no momento.";
        }
        console.log('Insight generated successfully')

        return new Response(JSON.stringify({ success: true, insight: insightText }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })

    } catch (error: any) {
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
})
