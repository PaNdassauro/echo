import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1'
import { createErrorResponse } from '../_shared/error-utils.ts';
import { checkInternalCaller } from '../_shared/authz.ts';

// API CONFIG
const GRAPH_API_VERSION = 'v18.0';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'meta api error': 'Erro ao buscar dados do WhatsApp.',
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

    // Varre TODAS as organizações e chama a Graph API de cada uma (DoS e custo).
    // Só o cron fetch-analytics-daily chama, com a service_role do Vault; o front não usa.
    const denied = checkInternalCaller(req, 'fetch-analytics-data', { headers: corsHeaders });
    if (denied) return denied;

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // 1. Get all active Organizations with WABA IDs
        const { data: orgs, error: orgError } = await supabaseClient
            .from('organizations')
            .select('id, name, whatsapp_waba_id, whatsapp_access_token')
            .not('whatsapp_waba_id', 'is', null)
            .not('whatsapp_access_token', 'is', null);

        if (orgError) throw orgError;

        const results = [];

        // Calculate Dates (Yesterday by default, or passed params)
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // Format YYYY-MM-DD
        const startTime = Math.floor(yesterday.setHours(0, 0, 0, 0) / 1000);
        const endTime = Math.floor(today.setHours(0, 0, 0, 0) / 1000);
        const dateStr = yesterday.toISOString().split('T')[0]; // For DB storage

        console.log(`fetching for ${dateStr} (${startTime} to ${endTime})`);

        for (const org of orgs) {
            if (!org.whatsapp_waba_id || !org.whatsapp_access_token) continue;

            console.log(`Processing Org: ${org.name} (${org.id})`);

            try {
                // A. Fetch Conversation Analytics (COST)
                const costUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${org.whatsapp_waba_id}?fields=conversation_analytics.start(${startTime}).end(${endTime}).granularity(DAILY).dimensions(CONVERSATION_CATEGORY)`;

                const costRes = await fetch(costUrl, {
                    headers: { 'Authorization': `Bearer ${org.whatsapp_access_token}` }
                });
                const costData = await costRes.json();

                if (costData.conversation_analytics && costData.conversation_analytics.data) {
                    let totalCost = 0;
                    let convCount = 0;
                    let currency = 'BRL';

                    for (const item of costData.conversation_analytics.data) {
                        if (item.data_points) {
                            for (const point of item.data_points) {
                                totalCost += Number(point.cost?.value || 0);
                                convCount += Number(point.conversation_count || 0);
                                if (point.cost?.currency) currency = point.cost.currency;
                            }
                        }
                    }

                    const { error: dbError } = await supabaseClient
                        .from('analytics_daily_metrics')
                        .upsert({
                            organization_id: org.id,
                            date: dateStr,
                            total_cost: totalCost,
                            conversation_count: convCount,
                            currency: currency
                        }, { onConflict: 'organization_id, date' });

                    if (dbError) console.error('Error saving cost metrics:', dbError);
                    else results.push({ org: org.name, type: 'cost', success: true });
                }


                // B. Fetch Template Analytics
                // Correct Flow: List Templates -> Get IDs -> Query Analytics with IDs

                // 1. Fetch all templates (names and IDs)
                const templatesMap = new Map(); // id -> name
                let templateCursor: string | null = null;
                let fetchMoreTemplates = true;
                const limit = 50;

                while (fetchMoreTemplates) {
                    const tListUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${org.whatsapp_waba_id}/message_templates?fields=id,name&limit=${limit}${templateCursor ? `&after=${templateCursor}` : ''}`;
                    const tListRes: Response = await fetch(tListUrl, {
                        headers: { 'Authorization': `Bearer ${org.whatsapp_access_token}` }
                    });
                    const tListData: {
                        data?: Array<{ id: string; name: string }>;
                        paging?: { next?: string; cursors?: { after?: string } };
                    } = await tListRes.json();

                    if (tListData.data) {
                        for (const t of tListData.data) {
                            templatesMap.set(t.id, t.name);
                        }
                    }

                    if (tListData.paging && tListData.paging.next && tListData.paging.cursors && tListData.paging.cursors.after) {
                        templateCursor = tListData.paging.cursors.after;
                    } else {
                        fetchMoreTemplates = false;
                    }
                }

                console.log(`Found ${templatesMap.size} templates for ${org.name}`);

                // 2. Batch Analytics Fetch (max 10 IDs per request as per Meta Limit)
                const templateIds = Array.from(templatesMap.keys());
                const batches = [];
                const batchSize = 10; // Meta Limit is strictly 10

                for (let i = 0; i < templateIds.length; i += batchSize) {
                    batches.push(templateIds.slice(i, i + batchSize));
                }

                let processedCount = 0;
                let errorDetails = [];

                for (const batchIds of batches) {
                    // Escape IDs for URL: ['1', '2']
                    const idsParam = `['${batchIds.join("','")}']`;

                    const tempUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${org.whatsapp_waba_id}?fields=template_analytics.template_ids(${idsParam}).start(${startTime}).end(${endTime}).granularity(DAILY).metric_types(CLICKED,DELIVERED,READ,SENT)`;

                    try {
                        const tempRes = await fetch(tempUrl, {
                            headers: { 'Authorization': `Bearer ${org.whatsapp_access_token}` }
                        });
                        const tempData = await tempRes.json();

                        if (tempData.template_analytics && tempData.template_analytics.data) {
                            for (const dataItem of tempData.template_analytics.data) {
                                if (dataItem.data_points) {
                                    for (const point of dataItem.data_points) {
                                        const tId = point.template_id;
                                        const tName = templatesMap.get(tId) || 'Unknown';

                                        const sent = point.sent || 0;
                                        const delivered = point.delivered || 0;
                                        const read = point.read || 0;

                                        // Handle 'clicked' which can be a number or an array/object breakdown
                                        let clicked = 0;
                                        if (typeof point.clicked === 'number') {
                                            clicked = point.clicked;
                                        } else if (Array.isArray(point.clicked)) {
                                            // Sum up counts from breakdown: [{type:..., count: 1}, ...]
                                            clicked = point.clicked.reduce((acc: number, item: any) => acc + (Number(item.count) || 0), 0);
                                        } else if (typeof point.clicked === 'object' && point.clicked !== null) {
                                            clicked = Number(point.clicked.count) || 0;
                                        }

                                        const { error: tmplDbError } = await supabaseClient
                                            .from('analytics_daily_templates')
                                            .upsert({
                                                organization_id: org.id,
                                                template_id: tId,
                                                template_name: tName,
                                                date: dateStr,
                                                category: 'UNKNOWN',
                                                sent,
                                                delivered,
                                                read,
                                                clicked
                                            }, { onConflict: 'organization_id, template_id, date' });

                                        if (tmplDbError) {
                                            console.error(`Error saving template ${tId}:`, tmplDbError);
                                            errorDetails.push(`DB Error ${tId}: ${tmplDbError.message}`);
                                        } else {
                                            processedCount++;
                                        }
                                    }
                                }
                            }
                        } else if (tempData.error) {
                            console.error(`Meta API Error for batch:`, tempData.error);
                            errorDetails.push(`API Error: ${tempData.error.message}`);
                        }
                    } catch (batchErr) {
                        console.error("Batch Fetch Error:", batchErr);
                        errorDetails.push(`Fetch Error: ${batchErr instanceof Error ? batchErr.message : String(batchErr)}`);
                    }
                }

                results.push({
                    org: org.name,
                    type: 'templates',
                    success: true,
                    count: templateIds.length,
                    processed: processedCount,
                    errors: errorDetails.slice(0, 5) // Return first 5 errors
                });

            } catch (err) {
                console.error(`Failed for org ${org.name}:`, err);
                results.push({ org: org.name, error: err instanceof Error ? err.message : String(err) });
            }
        }

        return new Response(JSON.stringify({ success: true, results }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })

    } catch (error: any) {
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
})
