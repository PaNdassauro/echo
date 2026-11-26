import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { checkInternalCaller } from '../_shared/authz.ts';
import { fetchExterno, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';
import { paraUrlInterna } from '../_shared/url-publica.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'qr_service_url not configured': 'Serviço QR não configurado.',
    'flow not found': 'Fluxo de automação não encontrado.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

interface ExecutionContext {
    organizationId: string;
    conversationId: string;
    phoneNumberDbId: string | null;
    metaPhoneNumberId: string | null;
    contactPhone: string;
    accessToken: string;
    connectionType?: 'official' | 'qr';
    triggerContext?: 'inbound' | 'outbound';
    message: {
        content: string;
        type: string;
        selectionId: string | null;
        mediaUrl?: string | null;
        mediaMimeType?: string | null;
        mediaFilename?: string | null;
        mediaBase64?: string | null;
    };
}

interface FlowNode {
    id: string;
    type: string;
    data: Record<string, any>;
    position: { x: number; y: number };
}

interface FlowEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
}

interface AutomationTrigger {
    id: string;
    trigger_type: string;
    trigger_config: {
        keywords?: string[];
        match_type?: string;
    };
    is_active: boolean;
}

interface AutomationFlow {
    id: string;
    trigger_type: string;
    trigger_config: {
        keywords?: string[];
        match_type?: string;
    };
    flow_data: {
        nodes: FlowNode[];
        edges: FlowEdge[];
    };
    is_active: boolean;
    run_in_groups?: boolean;
    automation_triggers?: AutomationTrigger[];
}

// ============================================================================
// EXECUTION LOGGER - Stores execution history in DB
// ============================================================================

interface ExecutionLogEntry {
    step: number;
    timestamp: string;
    type: 'info' | 'success' | 'error' | 'node' | 'trigger';
    message: string;
    node_id?: string;
    node_type?: string;
    details?: Record<string, any>;
}

class ExecutionLogger {
    private supabase: SupabaseClient;
    private executionId: string | null = null;
    private logs: ExecutionLogEntry[] = [];
    private stepCounter = 0;
    private ctx: ExecutionContext;

    constructor(supabase: SupabaseClient, ctx: ExecutionContext) {
        this.supabase = supabase;
        this.ctx = ctx;
    }

    async start(flowId: string, triggerType?: string, matchedBy?: string): Promise<void> {
        const { data, error } = await this.supabase
            .from('automation_executions')
            .insert({
                flow_id: flowId,
                organization_id: this.ctx.organizationId,
                conversation_id: this.ctx.conversationId,
                phone_number_id: this.ctx.phoneNumberDbId,
                contact_phone: this.ctx.contactPhone,
                status: 'running',
                trigger_message: {
                    content: this.ctx.message.content,
                    type: this.ctx.message.type,
                    selectionId: this.ctx.message.selectionId,
                },
                trigger_type: triggerType,
                matched_by: matchedBy,
                execution_log: [],
            })
            .select('id')
            .single();

        if (error) {
            console.error('[EXEC] Failed to create execution record:', error);
        } else {
            this.executionId = data.id;
        }
    }

    async startNoMatch(): Promise<void> {
        const { data, error } = await this.supabase
            .from('automation_executions')
            .insert({
                flow_id: null,
                organization_id: this.ctx.organizationId,
                conversation_id: this.ctx.conversationId,
                phone_number_id: this.ctx.phoneNumberDbId,
                contact_phone: this.ctx.contactPhone,
                status: 'no_match',
                trigger_message: {
                    content: this.ctx.message.content,
                    type: this.ctx.message.type,
                    selectionId: this.ctx.message.selectionId,
                },
                execution_log: [],
                completed_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) {
            console.error('[EXEC] Failed to create no_match execution record:', error);
        } else {
            this.executionId = data.id;
        }
    }

    log(type: ExecutionLogEntry['type'], message: string, details?: Record<string, any>): void {
        this.stepCounter++;
        const entry: ExecutionLogEntry = {
            step: this.stepCounter,
            timestamp: new Date().toISOString(),
            type,
            message,
            ...details,
        };
        this.logs.push(entry);
        console.log(`[EXEC] ${message}`);
    }

    logNode(nodeType: string, nodeId: string, message: string, details?: Record<string, any>): void {
        this.stepCounter++;
        const entry: ExecutionLogEntry = {
            step: this.stepCounter,
            timestamp: new Date().toISOString(),
            type: 'node',
            message,
            node_type: nodeType,
            node_id: nodeId,
            ...details,
        };
        this.logs.push(entry);
        console.log(`[EXEC] ▶️ NODE: ${nodeType} - ${message}`);
    }

    async complete(status: 'completed' | 'failed' | 'stopped' | 'no_match' | 'cancelled', stopReason?: string, error?: string): Promise<void> {
        if (!this.executionId) return;

        await this.supabase
            .from('automation_executions')
            .update({
                status,
                execution_log: this.logs,
                stop_reason: stopReason,
                error,
                completed_at: new Date().toISOString(),
            })
            .eq('id', this.executionId);
    }

    async updateLog(): Promise<void> {
        if (!this.executionId) return;

        await this.supabase
            .from('automation_executions')
            .update({ execution_log: this.logs })
            .eq('id', this.executionId);
    }

    setSessionId(sessionId: string): void {
        if (!this.executionId) return;

        this.supabase
            .from('automation_executions')
            .update({ session_id: sessionId })
            .eq('id', this.executionId)
            .then(() => {});
    }

    getId(): string | null {
        return this.executionId;
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    // S5: o contexto inteiro (organização, linha, telefone) vem do corpo, então
    // só serviço pode chamar. Chamadores: whatsapp-webhook (2 ramos) e
    // whatsapp-send, todos com SUPABASE_SERVICE_ROLE_KEY.
    // verify_jwt = true (padrão; ver config.toml).
    const denied = checkInternalCaller(req, 'automation-execute', {
        jwtVerifiedByGateway: true,
        headers: corsHeaders,
    });
    if (denied) return denied;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const ctx: ExecutionContext = await req.json();

        // Create execution logger
        const logger = new ExecutionLogger(supabase, ctx);

        // ========== EXECUTION LOG: START ==========
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[EXEC] 🚀 AUTOMATION EXECUTION START');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[EXEC] 📨 TRIGGER MESSAGE:');
        console.log(`[EXEC]    Content: "${ctx.message.content}"`);
        console.log(`[EXEC]    Type: ${ctx.message.type}`);
        console.log(`[EXEC]    SelectionId: ${ctx.message.selectionId || 'null'}`);
        console.log(`[EXEC]    MediaUrl: ${ctx.message.mediaUrl || 'null'}`);
        console.log('[EXEC] 📍 CONTEXT:');
        console.log(`[EXEC]    ConversationId: ${ctx.conversationId}`);
        console.log(`[EXEC]    OrganizationId: ${ctx.organizationId}`);
        console.log(`[EXEC]    PhoneNumberDbId: ${ctx.phoneNumberDbId}`);
        console.log(`[EXEC]    ContactPhone: ${ctx.contactPhone}`);
        console.log(`[EXEC]    ConnectionType: ${ctx.connectionType || 'official'}`);
        console.log(`[EXEC]    TriggerContext: ${ctx.triggerContext || 'inbound'}`);
        console.log('───────────────────────────────────────────────────────────────');

        await executeAutomationFlow(supabase, ctx, logger);

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        console.error('[EXEC] ❌ FATAL ERROR:', error);
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});

// ============================================================================
// AUTOMATION FLOW EXECUTOR
// ============================================================================

async function executeAutomationFlow(
    supabase: SupabaseClient,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    // ========== STEP 0: GRUPO OU 1:1 ==========
    // Descoberto aqui, pelo conversationId, e não recebido no payload: os três
    // chamadores (whatsapp-webhook nos dois canais e whatsapp-send) passam a
    // valer sem coordenação de deploy. Em grupo o `contactPhone` que chega é o
    // JID do grupo, logo qualquer nó de mensagem responde DENTRO do grupo.
    const { data: conv } = await supabase
        .from('conversations')
        .select('is_group, channel')
        .eq('id', ctx.conversationId)
        .maybeSingle();

    // Direct do Instagram: todo nó de mensagem sai por QR/Cloud API e mandaria
    // 'ig:<id>' como telefone (ver _shared/canal.ts). Um guard aqui cobre todos.
    if (conv?.channel === 'instagram') {
        console.warn(`[EXEC] Refusing Instagram Direct conversation ${ctx.conversationId}`);
        await logger.startNoMatch();
        logger.log('error', 'STOPPED: automação só existe no WhatsApp (conversa do Instagram Direct)');
        await logger.complete('stopped', 'Conversa do Instagram Direct');
        return;
    }

    const isGroupConversation = conv?.is_group === true;
    logger.log('info', `Conversation type: ${isGroupConversation ? 'group' : '1:1'}`);

    // ========== STEP 1: CHECK EXISTING SESSION ==========
    logger.log('info', 'Checking for existing active session...');

    const { data: existingSession, error: sessionError } = await supabase
        .from('automation_sessions')
        .select('*, automation_flows(*)')
        .eq('conversation_id', ctx.conversationId)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

    if (sessionError) {
        logger.log('error', `Session lookup error: ${sessionError.message}`);
    }

    if (existingSession) {
        const flow = existingSession.automation_flows;

        // Sessões de grupo abertas antes deste guard também param aqui.
        // D6: sem linha em automation_executions (ver STEP 2).
        if (isGroupConversation && flow?.run_in_groups !== true) {
            console.log(`[EXEC] STOPPED: "${flow?.name}" não roda em conversa de grupo (sem registro)`);
            return;
        }

        const flowData = typeof flow.flow_data === 'string'
            ? JSON.parse(flow.flow_data)
            : flow.flow_data;
        const nodes = flowData?.nodes || [];
        const currentNode = nodes.find((n: FlowNode) => n.id === existingSession.current_node_id);

        logger.log('info', `Found active session: ${existingSession.id}`, {
            details: { flow_name: flow.name, current_node: currentNode?.type }
        });

        const interactiveNodeTypes = ['listNode', 'buttonNode', 'surveyNode'];
        if (currentNode && interactiveNodeTypes.includes(currentNode.type)) {
            logger.log('info', `Node expects input - continuing flow`);
            // For continue flow, we start a new execution record
            await logger.start(flow.id, 'session_continue', `Continuing from ${currentNode.type}`);
            await continueFlow(supabase, existingSession, ctx, logger);
            return;
        } else {
            logger.log('info', `Node doesn't expect input - checking for new trigger`);
        }
    } else {
        logger.log('info', 'No active session found');
    }

    // ========== STEP 2: FIND MATCHING FLOWS ==========
    logger.log('info', 'Looking for matching flows...');

    const { data: flows } = await supabase
        .from('automation_flows')
        .select(`*, automation_triggers (id, trigger_type, trigger_config, is_active)`)
        .eq('organization_id', ctx.organizationId)
        .eq('is_active', true);

    // D6: os três "stopped" de triagem (nenhum fluxo ativo, nenhum fluxo da
    // linha, grupo sem run_in_groups) saem SEM linha em automation_executions.
    // Eram um INSERT + UPDATE por mensagem recebida em linha sem fluxo (86% das
    // linhas da tabela) e nada os lê além da lista do ExecutionsPanel. O
    // diagnóstico de "automação errada" continua: toda execução real (start())
    // e todo `no_match` de linha com fluxo seguem gravados.
    if (!flows || flows.length === 0) {
        console.log('[EXEC] STOPPED: no active flows (sem registro)');
        return;
    }

    logger.log('info', `Found ${flows.length} active flow(s) in organization`);

    // ========== STEP 3: FILTER BY PHONE NUMBER ==========
    logger.log('info', 'Filtering by phone number...');

    let matchingFlows = flows.filter((flow: any) => {
        const matches = !flow.phone_number_id || flow.phone_number_id === ctx.phoneNumberDbId;
        if (!matches) {
            logger.log('info', `"${flow.name}" - phone mismatch`, {
                details: { flow_phone: flow.phone_number_id, ctx_phone: ctx.phoneNumberDbId }
            });
        } else {
            logger.log('info', `"${flow.name}" - phone OK`);
        }
        return matches;
    });

    if (matchingFlows.length === 0) {
        console.log('[EXEC] STOPPED: all flows filtered out by phone number (sem registro)');
        return;
    }

    logger.log('info', `${matchingFlows.length} flow(s) passed phone filter`);

    // ========== STEP 3b: FILTER BY CONVERSATION TYPE (group opt-in) ==========
    // Filtro separado do de telefone para o stop_reason apontar o motivo certo.
    if (isGroupConversation) {
        logger.log('info', 'Filtering by group opt-in (run_in_groups)...');

        const groupAllowedFlows = matchingFlows.filter((flow: any) => {
            const allowed = flow.run_in_groups === true;
            logger.log('info', `"${flow.name}" - ${allowed ? 'roda em grupo' : 'grupo bloqueado (run_in_groups desligado)'}`);
            return allowed;
        });

        if (groupAllowedFlows.length === 0) {
            console.log('[EXEC] STOPPED: nenhum fluxo habilitado para conversa de grupo (sem registro)');
            return;
        }

        matchingFlows = groupAllowedFlows;
        logger.log('info', `${matchingFlows.length} flow(s) passed group filter`);
    }

    // ========== STEP 4: MATCH TRIGGERS (collect ALL matching flows) ==========
    const triggerContext = ctx.triggerContext || 'inbound';
    logger.log('info', `Matching triggers (direction: ${triggerContext})...`);

    const triggeredFlows: Array<{ flow: any; matchResult: TriggerMatchResult }> = [];

    for (const flow of matchingFlows) {
        logger.log('trigger', `Checking flow: "${flow.name}"`);
        const matchResult = matchesAnyTriggerWithLog(flow, ctx.message, triggerContext);

        if (matchResult.matched) {
            logger.log('success', `TRIGGER MATCHED: "${flow.name}"`, { details: { matched_by: matchResult.matchedBy } });
            triggeredFlows.push({ flow, matchResult });
        }
    }

    // No flows matched - log as no_match
    if (triggeredFlows.length === 0) {
        await logger.startNoMatch();
        logger.log('error', 'STOPPED: No flows matched the trigger conditions');
        await logger.complete('no_match', 'No trigger conditions matched');
        return;
    }

    // ========== STEP 5: EXECUTE ALL MATCHING FLOWS ==========
    logger.log('info', `${triggeredFlows.length} flow(s) matched - executing all`);

    for (let i = 0; i < triggeredFlows.length; i++) {
        const { flow, matchResult } = triggeredFlows[i];

        // Each flow gets its own logger instance
        const flowLogger = new ExecutionLogger(supabase, ctx);
        await flowLogger.start(flow.id, matchResult.matchedBy?.split(' ')[0] || 'unknown', matchResult.matchedBy || undefined);

        logger.log('info', `Starting flow ${i + 1}/${triggeredFlows.length}: "${flow.name}"`);
        await startFlow(supabase, flow, ctx, flowLogger);
    }
}

interface TriggerMatchResult {
    matched: boolean;
    matchedBy: string | null;
}

function matchesAnyTriggerWithLog(
    flow: AutomationFlow,
    message: { content: string; type: string },
    triggerContext: 'inbound' | 'outbound'
): TriggerMatchResult {
    // Get triggers from new table, with active filter
    let triggers: AutomationTrigger[] = (flow.automation_triggers || []).filter(t => t.is_active);

    // Fallback to legacy trigger_type/trigger_config if no triggers in new table
    if (triggers.length === 0 && flow.trigger_type) {
        console.log(`[EXEC]    Using legacy trigger config`);
        triggers = [{
            id: 'legacy',
            trigger_type: flow.trigger_type,
            trigger_config: flow.trigger_config || {},
            is_active: true
        }];
    }

    console.log(`[EXEC]    Found ${triggers.length} trigger(s)`);

    // Filter triggers by context (inbound vs outbound)
    const relevantTriggers = triggers.filter(t => {
        if (triggerContext === 'outbound') {
            return t.trigger_type === 'message_sent';
        } else {
            return t.trigger_type !== 'message_sent';
        }
    });

    if (relevantTriggers.length === 0) {
        console.log(`[EXEC]    ❌ No triggers match context "${triggerContext}"`);
        return { matched: false, matchedBy: null };
    }

    console.log(`[EXEC]    ${relevantTriggers.length} trigger(s) match context "${triggerContext}"`);

    // OR logic - any trigger match = flow triggers
    for (const trigger of relevantTriggers) {
        const result = matchSingleTriggerWithLog(trigger, message);
        if (result.matched) {
            return result;
        }
    }

    return { matched: false, matchedBy: null };
}

/**
 * Normalização usada nos dois lados da comparação de palavra-chave.
 *
 * Só caixa e espaço: pontuação e acento são preservados de propósito. Duas
 * campanhas disparando o MESMO texto de botão só se distinguem pelo que o
 * template escreveu (ex.: o ponto final em "Sim, já comprei." vs "Sim, já
 * comprei"); um `contains` frouxo faria o fluxo errado atender.
 */
function normalizeForMatch(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function matchSingleTriggerWithLog(
    trigger: AutomationTrigger,
    message: { content: string; type: string }
): TriggerMatchResult {
    const config = trigger.trigger_config || {};

    console.log(`[EXEC]    🎯 Testing trigger: ${trigger.trigger_type}`);

    switch (trigger.trigger_type) {
        case 'message_received':
            console.log(`[EXEC]       → message_received: ALWAYS MATCHES`);
            return { matched: true, matchedBy: 'message_received (any message)' };

        case 'message_sent':
            console.log(`[EXEC]       → message_sent: ALWAYS MATCHES`);
            return { matched: true, matchedBy: 'message_sent (any outbound)' };

        case 'keyword':
            const keywords = config.keywords || [];
            // Default de runtime segue 'contains': fluxos antigos (ex: "tarifário"
            // no meio da frase) dependem de substring. A UI grava 'exact' nos
            // novos, e é o exact que separa "Sim, já comprei." de "Sim, já comprei".
            const matchType = config.match_type || 'contains';
            const messageText = normalizeForMatch(message.content);

            console.log(`[EXEC]       → keyword trigger (${matchType})`);
            console.log(`[EXEC]       → Keywords: ${JSON.stringify(keywords)}`);
            console.log(`[EXEC]       → Message: "${messageText}"`);

            if (keywords.length === 0) {
                console.log(`[EXEC]       ❌ No keywords configured`);
                return { matched: false, matchedBy: null };
            }

            for (const keyword of keywords) {
                const kw = normalizeForMatch(keyword as string);
                if (!kw) continue;

                let matches = false;
                if (matchType === 'exact') {
                    matches = messageText === kw;
                    console.log(`[EXEC]       → Exact match "${kw}": ${matches ? '✅' : '❌'}`);
                } else {
                    matches = messageText.includes(kw);
                    console.log(`[EXEC]       → Contains "${kw}": ${matches ? '✅' : '❌'}`);
                }

                if (matches) {
                    return { matched: true, matchedBy: `keyword "${kw}" (${matchType})` };
                }
            }

            console.log(`[EXEC]       ❌ No keyword matched`);
            return { matched: false, matchedBy: null };

        case 'conversation_created':
            console.log(`[EXEC]       ❌ conversation_created: NOT IMPLEMENTED`);
            return { matched: false, matchedBy: null };

        default:
            console.log(`[EXEC]       ❌ Unknown trigger type: ${trigger.trigger_type}`);
            return { matched: false, matchedBy: null };
    }
}

async function startFlow(
    supabase: SupabaseClient,
    flow: any,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    logger.log('info', `Starting flow: "${flow.name}" (${flow.id})`);

    const cooldownMinutes = flow.cooldown_minutes ?? 30;
    logger.log('info', `Cooldown: ${cooldownMinutes} minutes`);

    const flowData = typeof flow.flow_data === 'string'
        ? JSON.parse(flow.flow_data)
        : flow.flow_data;

    const nodes = flowData.nodes || [];
    const edges = flowData.edges || [];

    logger.log('info', `Flow has ${nodes.length} nodes, ${edges.length} edges`);

    const triggerNode = nodes.find((n: FlowNode) => n.type === 'triggerNode');
    if (!triggerNode) {
        logger.log('error', 'No trigger node found in flow');
        await logger.complete('failed', 'No trigger node found');
        return;
    }

    const triggerEdges = edges.filter((e: FlowEdge) => e.source === triggerNode.id);
    const firstEdge = triggerEdges[0];
    if (!firstEdge) {
        logger.log('error', 'No nodes connected to trigger (empty flow)');
        await logger.complete('failed', 'Empty flow - no nodes connected');
        return;
    }

    const firstNode = nodes.find((n: FlowNode) => n.id === firstEdge.target);
    if (!firstNode) {
        logger.log('error', 'First node not found');
        await logger.complete('failed', 'First node not found');
        return;
    }

    logger.log('info', `First node: ${firstNode.type} (${firstNode.id})`);

    // Check cooldown
    logger.log('info', 'Checking cooldown & creating session...');

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'trigger_automation_flow_atomic',
        {
            p_flow_id: flow.id,
            p_conversation_id: ctx.conversationId,
            p_cooldown_minutes: cooldownMinutes,
            p_context: {
                message: ctx.message,
                started_at: new Date().toISOString(),
            },
            p_start_node_id: firstNode.id
        }
    );

    if (rpcError) {
        logger.log('error', `RPC Error: ${rpcError.message}`);
        await logger.complete('failed', 'RPC Error', rpcError.message);
        return;
    }

    const result = (Array.isArray(rpcResult) && rpcResult.length > 0) ? rpcResult[0] : rpcResult;

    if (!result) {
        logger.log('error', 'RPC returned no result');
        await logger.complete('failed', 'RPC returned no result');
        return;
    }

    if (result.status === 'cooldown_active') {
        logger.log('info', `Cooldown active: ${result.message}`);
        await logger.complete('stopped', `Cooldown active: ${result.message}`);
        return;
    }

    if (result.status === 'success' && result.session_id) {
        logger.log('success', `Session created: ${result.session_id}`);
        logger.setSessionId(result.session_id);

        const session = {
            id: result.session_id,
            flow_id: flow.id,
            conversation_id: ctx.conversationId,
            current_node_id: firstNode.id,
            context: {
                message: ctx.message,
                started_at: new Date().toISOString(),
            },
            status: 'active',
            automation_flows: flow
        };

        logger.log('info', 'Executing nodes...');
        await executeNode(supabase, firstNode, nodes, edges, session, ctx, logger);
    } else {
        logger.log('error', `Unknown RPC status: ${result.status}`);
        await logger.complete('failed', `Unknown RPC status: ${result.status}`);
    }
}

async function continueFlow(
    supabase: SupabaseClient,
    session: any,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    const flow = session.automation_flows;
    const flowData = typeof flow.flow_data === 'string'
        ? JSON.parse(flow.flow_data)
        : flow.flow_data;

    const nodes = flowData.nodes || [];
    const edges = flowData.edges || [];

    const currentNode = nodes.find((n: FlowNode) => n.id === session.current_node_id);
    if (!currentNode) {
        logger.log('error', 'Current node not found');
        await endSession(supabase, session.id, 'completed', logger);
        return;
    }

    logger.log('info', `Continuing flow: "${flow.name}"`, {
        details: { session_id: session.id, current_node: currentNode.type, user_response: ctx.message.content }
    });

    if (currentNode.type === 'conditionNode') {
        const nextNodeIds = evaluateCondition(currentNode, ctx.message, edges);

        if (nextNodeIds.length > 0) {
            await updateSession(supabase, session.id, nextNodeIds[nextNodeIds.length - 1]);
            for (const nodeId of nextNodeIds) {
                const nextNode = nodes.find((n: FlowNode) => n.id === nodeId);
                if (nextNode) {
                    await executeNode(supabase, nextNode, nodes, edges, session, ctx, logger);
                }
            }
        } else {
            await endSession(supabase, session.id, 'completed', logger);
        }
        return;
    }

    if (currentNode.type === 'listNode' || currentNode.type === 'buttonNode') {
        logger.log('info', `User responded to ${currentNode.type}`);

        const nextEdges = edges.filter((e: FlowEdge) => e.source === currentNode.id);
        if (nextEdges.length > 0) {
            await updateSession(supabase, session.id, nextEdges[nextEdges.length - 1].target);

            for (const edge of nextEdges) {
                const nextNode = nodes.find((n: FlowNode) => n.id === edge.target);
                if (nextNode) {
                    if (nextNode.type === 'conditionNode') {
                        logger.log('info', 'Next is condition, evaluating...');
                        const branchNodeIds = evaluateCondition(nextNode, ctx.message, edges);

                        for (const nodeId of branchNodeIds) {
                            const branchNode = nodes.find((n: FlowNode) => n.id === nodeId);
                            if (branchNode) {
                                await executeNode(supabase, branchNode, nodes, edges, session, ctx, logger);
                            }
                        }
                    } else {
                        await executeNode(supabase, nextNode, nodes, edges, session, ctx, logger);
                    }
                }
            }
            return;
        }

        logger.log('info', 'No more nodes after user response');
        await endSession(supabase, session.id, 'completed', logger);
        return;
    }

    if (currentNode.type === 'surveyNode') {
        logger.log('info', 'User responded to survey question');
        await executeSurveyNode(supabase, currentNode, nodes, edges, session, ctx, logger);
        return;
    }

    if (currentNode.type === 'businessHoursNode') {
        logger.log('info', 'Re-evaluating business hours on continue...');
        await executeNode(supabase, currentNode, nodes, edges, session, ctx, logger);
        return;
    }

    const nextEdges = edges.filter((e: FlowEdge) => e.source === currentNode.id);
    if (nextEdges.length > 0) {
        await updateSession(supabase, session.id, nextEdges[nextEdges.length - 1].target);
        for (const edge of nextEdges) {
            const nextNode = nodes.find((n: FlowNode) => n.id === edge.target);
            if (nextNode) {
                await executeNode(supabase, nextNode, nodes, edges, session, ctx, logger);
            }
        }
    } else {
        await endSession(supabase, session.id, 'completed', logger);
    }
}

function evaluateCondition(
    node: FlowNode,
    message: { content: string; selectionId: string | null },
    edges: FlowEdge[]
): string[] {
    const conditions = node.data.conditions || [];
    const targetNodeIds: string[] = [];

    const selectionId = (message.selectionId || '').toLowerCase().trim();
    const content = (message.content || '').toLowerCase().trim();

    console.log(`[EXEC]    Condition Input: selectionId="${selectionId}", content="${content}"`);

    for (let i = 0; i < conditions.length; i++) {
        const condition = conditions[i];
        const conditionValue = (condition.value || '').toLowerCase().trim();

        if (!conditionValue) continue;

        const matches =
            selectionId === conditionValue ||
            content === conditionValue ||
            selectionId.includes(conditionValue) ||
            content.includes(conditionValue) ||
            conditionValue.includes(selectionId) ||
            conditionValue.includes(content);

        console.log(`[EXEC]    Condition[${i}] "${conditionValue}": ${matches ? '✅ MATCH' : '❌'}`);

        if (matches) {
            const handle = String.fromCharCode(97 + i);
            const branchEdges = edges.filter((e: FlowEdge) => e.source === node.id && e.sourceHandle === handle);
            branchEdges.forEach(edge => {
                targetNodeIds.push(edge.target);
            });
        }
    }

    if (targetNodeIds.length > 0) {
        console.log(`[EXEC]    → Branching to ${targetNodeIds.length} target(s)`);
        return targetNodeIds;
    }

    console.log('[EXEC]    → No match, using DEFAULT branch');
    const defaultEdges = edges.filter((e: FlowEdge) => e.source === node.id && e.sourceHandle === 'default');
    return defaultEdges.map(e => e.target);
}

async function executeNode(
    supabase: SupabaseClient,
    node: FlowNode,
    nodes: FlowNode[],
    edges: FlowEdge[],
    session: any,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    logger.logNode(node.type, node.id, `Executing ${node.type}`);

    switch (node.type) {
        case 'messageNode':
            logger.logNode(node.type, node.id, `Sending text: "${(node.data.message || '').substring(0, 50)}..."`);
            await sendTextMessage(supabase, ctx, node.data.message || '');
            logger.logNode(node.type, node.id, 'Text sent');
            await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
            break;

        case 'listNode':
            logger.logNode(node.type, node.id, 'Sending list message');
            await sendListMessage(supabase, ctx, node.data);
            logger.logNode(node.type, node.id, 'Waiting for user selection...');
            await updateSession(supabase, session.id, node.id);
            await logger.updateLog();
            break;

        case 'buttonNode':
            logger.logNode(node.type, node.id, 'Sending button message');
            await sendButtonMessage(supabase, ctx, node.data);
            logger.logNode(node.type, node.id, 'Waiting for user selection...');
            await updateSession(supabase, session.id, node.id);
            await logger.updateLog();
            break;

        case 'conditionNode':
            logger.logNode(node.type, node.id, 'Evaluating condition...');
            const conditionTargets = evaluateCondition(node, ctx.message, edges);

            if (conditionTargets.length > 0) {
                logger.logNode(node.type, node.id, `Condition matched, branching to ${conditionTargets.length} target(s)`);
                await updateSession(supabase, session.id, conditionTargets[conditionTargets.length - 1]);
                for (const targetId of conditionTargets) {
                    const targetNode = nodes.find((n: FlowNode) => n.id === targetId);
                    if (targetNode) {
                        await executeNode(supabase, targetNode, nodes, edges, session, ctx, logger);
                    }
                }
            } else {
                logger.logNode(node.type, node.id, 'No condition matched, no default branch');
                await endSession(supabase, session.id, 'completed', logger);
            }
            break;

        case 'delayNode':
            logger.logNode(node.type, node.id, `Delay: ${node.data.seconds}s (skipped in sync mode)`);
            await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
            break;

        case 'businessHoursNode':
            const isOpen = isWithinBusinessHours(node.data);
            logger.logNode(node.type, node.id, `Business hours: ${isOpen ? 'OPEN' : 'CLOSED'}`);

            const handleId = isOpen ? 'open' : 'closed';
            const nextEdgesByHandle = edges.filter((e: FlowEdge) => e.source === node.id && e.sourceHandle === handleId);

            if (nextEdgesByHandle.length > 0) {
                logger.logNode(node.type, node.id, `Taking "${handleId}" branch`);
                await updateSession(supabase, session.id, nextEdgesByHandle[nextEdgesByHandle.length - 1].target);
                for (const edge of nextEdgesByHandle) {
                    const nextNode = nodes.find((n: FlowNode) => n.id === edge.target);
                    if (nextNode) {
                        await executeNode(supabase, nextNode, nodes, edges, session, ctx, logger);
                    }
                }
            } else {
                logger.logNode(node.type, node.id, `No edge for "${handleId}" branch`);
                await endSession(supabase, session.id, 'completed', logger);
            }
            break;

        case 'webhookNode':
            logger.logNode(node.type, node.id, `Calling webhook: ${node.data.url}`);
            await sendWebhookNode(supabase, ctx, node.data, session);
            logger.logNode(node.type, node.id, 'Webhook sent');
            await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
            break;

        case 'mediaNode':
            logger.logNode(node.type, node.id, `Sending media: ${node.data.filename || node.data.mediaUrl}`);
            await sendMediaMessage(supabase, ctx, node.data);
            logger.logNode(node.type, node.id, 'Media sent');
            await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
            break;

        case 'surveyNode':
            logger.logNode(node.type, node.id, 'Executing survey node');
            await executeSurveyNode(supabase, node, nodes, edges, session, ctx, logger);
            break;

        default:
            logger.logNode(node.type, node.id, `Unknown node type: ${node.type}`);
            await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
    }
}

async function moveToNextNode(
    supabase: SupabaseClient,
    currentNode: FlowNode,
    nodes: FlowNode[],
    edges: FlowEdge[],
    session: any,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    const nextEdges = edges.filter((e: FlowEdge) => e.source === currentNode.id);

    if (nextEdges.length > 0) {
        await updateSession(supabase, session.id, nextEdges[nextEdges.length - 1].target);

        for (const edge of nextEdges) {
            const nextNode = nodes.find((n: FlowNode) => n.id === edge.target);
            if (nextNode) {
                logger.log('info', `Moving to next node: ${nextNode.type}`);
                await executeNode(supabase, nextNode, nodes, edges, session, ctx, logger);
            }
        }
    } else {
        logger.log('info', 'No more nodes (end of flow)');
        await endSession(supabase, session.id, 'completed', logger);
    }
}

async function sendTextMessage(supabase: SupabaseClient, ctx: ExecutionContext, text: string): Promise<void> {
    if (!text.trim()) return;

    try {
        let whatsappMessageId: string | null = null;

        if (ctx.connectionType === 'qr') {
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) throw new Error('QR_SERVICE_URL not configured');

            console.log(`[Automation-QR] Sending text to ${ctx.contactPhone}`);
            const response = await fetch(`${qrServiceUrl}/message/send/${ctx.phoneNumberDbId}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ to: ctx.contactPhone, content: text }),
            });

            const data = await response.json();
            whatsappMessageId = data.messageId || (data.success ? `qr_${Date.now()}` : null);
        } else {
            console.log(`[Automation-Official] Sending text to ${ctx.contactPhone}`);
            const response = await fetch(
                `https://graph.facebook.com/v18.0/${ctx.metaPhoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${ctx.accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: ctx.contactPhone,
                        type: 'text',
                        text: { body: text },
                    }),
                }
            );

            const data = await response.json();
            whatsappMessageId = data.messages?.[0]?.id;
        }

        console.log('[Automation] Text message sent:', whatsappMessageId || 'no id');

        if (whatsappMessageId) {
            const { data: savedMessage, error: saveError } = await supabase
                .from('messages')
                .insert({
                    conversation_id: ctx.conversationId,
                    content: text,
                    direction: 'outbound',
                    whatsapp_message_id: whatsappMessageId,
                    message_type: 'text',
                    metadata: { automacao: true },
                })
                .select('id')
                .maybeSingle();

            if (saveError) {
                // O contato JÁ recebeu — insert falho = robô mudo no CRM.
                console.error('[Automation] Failed to save message (automation-text):', saveError);
                await logWriteFailure(supabase, {
                    toJid: String(ctx.contactPhone ?? ctx.conversationId),
                    wamid: whatsappMessageId,
                    action: 'msg_write_failed',
                    error: `${saveError.code ?? 'unknown'}: ${saveError.message}`,
                    route: 'automation-text',
                    payload: { conversation_id: ctx.conversationId, content: text, whatsapp_message_id: whatsappMessageId },
                });
            }

            if (savedMessage) {
                await emitMessageSent(supabase, {
                    conversationId: ctx.conversationId,
                    messageId: savedMessage.id,
                    whatsappMessageId,
                    content: text,
                    messageType: 'text',
                    sentBy: null,
                    origin: 'automation',
                    phoneNumberDbId: ctx.phoneNumberDbId,
                    organizationId: ctx.organizationId,
                    metaPhoneNumberId: ctx.metaPhoneNumberId,
                });
            }
        }
    } catch (error) {
        console.error('[Automation] Failed to send text message:', error);
    }
}

async function sendListMessage(supabase: SupabaseClient, ctx: ExecutionContext, nodeData: any): Promise<void> {
    const { header, body, footer, buttonText, sections } = nodeData;

    if (!body || !sections || sections.length === 0) {
        console.error('[Automation] List message missing required fields');
        return;
    }

    try {
        let whatsappMessageId: string | null = null;
        let displayContent = '';
        if (header) displayContent += `*${header}*\n\n`;
        displayContent += body;

        sections.forEach((section: any) => {
            if (section.title) displayContent += `\n\n📋 ${section.title}`;
            (section.rows || []).forEach((row: any) => {
                displayContent += `\n• ${row.title}`;
                if (row.description) displayContent += ` - ${row.description}`;
            });
        });
        if (footer) displayContent += `\n\n_${footer}_`;

        if (ctx.connectionType === 'qr') {
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) throw new Error('QR_SERVICE_URL not configured');

            console.log(`[Automation-QR] Sending list (as text fallback) to ${ctx.contactPhone}`);
            const response = await fetch(`${qrServiceUrl}/message/send/${ctx.phoneNumberDbId}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    to: ctx.contactPhone,
                    content: displayContent + "\n\n(Responda com o nome da opção desejada)"
                }),
            });

            const data = await response.json();
            whatsappMessageId = data.messageId || (data.success ? `qr_${Date.now()}` : null);
        } else {
            console.log(`[Automation-Official] Sending list to ${ctx.contactPhone}`);
            const payload: any = {
                messaging_product: 'whatsapp',
                to: ctx.contactPhone,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: body },
                    action: {
                        button: buttonText || 'Ver opções',
                        sections: sections.map((section: any) => ({
                            title: section.title || 'Opções',
                            rows: (section.rows || []).map((row: any) => ({
                                id: row.id,
                                title: row.title,
                                description: row.description || undefined,
                            })),
                        })),
                    },
                },
            };

            if (header) payload.interactive.header = { type: 'text', text: header };
            if (footer) payload.interactive.footer = { text: footer };

            const response = await fetch(
                `https://graph.facebook.com/v18.0/${ctx.metaPhoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${ctx.accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                }
            );

            const data = await response.json();
            whatsappMessageId = data.messages?.[0]?.id;
        }

        if (whatsappMessageId) {
            const { data: savedMessage, error: saveError } = await supabase
                .from('messages')
                .insert({
                    conversation_id: ctx.conversationId,
                    content: displayContent,
                    direction: 'outbound',
                    whatsapp_message_id: whatsappMessageId,
                    message_type: 'text',
                    metadata: { automacao: true },
                })
                .select('id')
                .maybeSingle();

            if (saveError) {
                // O contato JÁ recebeu — insert falho = robô mudo no CRM.
                console.error('[Automation] Failed to save message (automation-list):', saveError);
                await logWriteFailure(supabase, {
                    toJid: String(ctx.contactPhone ?? ctx.conversationId),
                    wamid: whatsappMessageId,
                    action: 'msg_write_failed',
                    error: `${saveError.code ?? 'unknown'}: ${saveError.message}`,
                    route: 'automation-list',
                    payload: { conversation_id: ctx.conversationId, content: displayContent, whatsapp_message_id: whatsappMessageId },
                });
            }

            if (savedMessage) {
                await emitMessageSent(supabase, {
                    conversationId: ctx.conversationId,
                    messageId: savedMessage.id,
                    whatsappMessageId,
                    content: displayContent,
                    messageType: 'text',
                    sentBy: null,
                    origin: 'automation',
                    phoneNumberDbId: ctx.phoneNumberDbId,
                    organizationId: ctx.organizationId,
                    metaPhoneNumberId: ctx.metaPhoneNumberId,
                });
            }
        }
    } catch (error) {
        console.error('[Automation] Failed to send list message:', error);
    }
}

async function sendButtonMessage(supabase: SupabaseClient, ctx: ExecutionContext, nodeData: any): Promise<void> {
    const { body, buttons } = nodeData;

    if (!body || !buttons || buttons.length === 0) {
        console.error('[Automation] Button message missing required fields');
        return;
    }

    try {
        let whatsappMessageId: string | null = null;
        let displayContent = body;
        displayContent += '\n\n';
        buttons.slice(0, 3).forEach((btn: any) => {
            displayContent += `🔘 ${btn.title}\n`;
        });

        if (ctx.connectionType === 'qr') {
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) throw new Error('QR_SERVICE_URL not configured');

            console.log(`[Automation-QR] Sending buttons (as text fallback) to ${ctx.contactPhone}`);
            const response = await fetch(`${qrServiceUrl}/message/send/${ctx.phoneNumberDbId}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    to: ctx.contactPhone,
                    content: displayContent.trim() + "\n\n(Respond com o nome do botão)"
                }),
            });

            const data = await response.json();
            whatsappMessageId = data.messageId || (data.success ? `qr_${Date.now()}` : null);
        } else {
            console.log(`[Automation-Official] Sending buttons to ${ctx.contactPhone}`);
            const payload = {
                messaging_product: 'whatsapp',
                to: ctx.contactPhone,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: body },
                    action: {
                        buttons: buttons.slice(0, 3).map((btn: any) => ({
                            type: 'reply',
                            reply: { id: btn.id, title: btn.title },
                        })),
                    },
                },
            };

            const response = await fetch(
                `https://graph.facebook.com/v18.0/${ctx.metaPhoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${ctx.accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                }
            );

            const data = await response.json();
            whatsappMessageId = data.messages?.[0]?.id;
        }

        if (whatsappMessageId) {
            const { data: savedMessage, error: saveError } = await supabase
                .from('messages')
                .insert({
                    conversation_id: ctx.conversationId,
                    content: displayContent.trim(),
                    direction: 'outbound',
                    whatsapp_message_id: whatsappMessageId,
                    message_type: 'text',
                    metadata: { automacao: true },
                })
                .select('id')
                .maybeSingle();

            if (saveError) {
                // O contato JÁ recebeu — insert falho = robô mudo no CRM.
                console.error('[Automation] Failed to save message (automation-buttons):', saveError);
                await logWriteFailure(supabase, {
                    toJid: String(ctx.contactPhone ?? ctx.conversationId),
                    wamid: whatsappMessageId,
                    action: 'msg_write_failed',
                    error: `${saveError.code ?? 'unknown'}: ${saveError.message}`,
                    route: 'automation-buttons',
                    payload: { conversation_id: ctx.conversationId, content: displayContent.trim(), whatsapp_message_id: whatsappMessageId },
                });
            }

            if (savedMessage) {
                await emitMessageSent(supabase, {
                    conversationId: ctx.conversationId,
                    messageId: savedMessage.id,
                    whatsappMessageId,
                    content: displayContent.trim(),
                    messageType: 'text',
                    sentBy: null,
                    origin: 'automation',
                    phoneNumberDbId: ctx.phoneNumberDbId,
                    organizationId: ctx.organizationId,
                    metaPhoneNumberId: ctx.metaPhoneNumberId,
                });
            }
        }
    } catch (error) {
        console.error('[Automation] Failed to send button message:', error);
    }
}

async function sendMediaMessage(supabase: SupabaseClient, ctx: ExecutionContext, nodeData: any): Promise<void> {
    const { mediaUrl, caption, filename, mimeType } = nodeData;

    if (!mediaUrl) {
        console.error('[Automation] Media node missing mediaUrl, skipping');
        return;
    }

    try {
        let whatsappMessageId: string | null = null;

        // Determine media type from MIME
        let mediaType = 'document';
        if (mimeType?.startsWith('image/')) {
            mediaType = 'image';
        } else if (mimeType?.startsWith('video/')) {
            mediaType = 'video';
        } else if (mimeType?.startsWith('audio/')) {
            mediaType = 'audio';
        }

        if (ctx.connectionType === 'qr') {
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) throw new Error('QR_SERVICE_URL not configured');

            console.log(`[Automation-QR] Sending media to ${ctx.contactPhone}: ${filename}`);
            const response = await fetch(`${qrServiceUrl}/message/send-media/${ctx.phoneNumberDbId}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    to: ctx.contactPhone,
                    media_url: mediaUrl,
                    mime_type: mimeType,
                    filename: filename,
                    caption: caption || undefined,
                }),
            });

            const data = await response.json();
            whatsappMessageId = data.messageId || (data.success ? `qr_${Date.now()}` : null);
        } else {
            console.log(`[Automation-Official] Sending media to ${ctx.contactPhone}: ${filename}`);

            const messageBody: any = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: ctx.contactPhone,
                type: mediaType,
            };

            messageBody[mediaType] = {
                link: mediaUrl,
            };

            // Add caption for image/video/document
            if (caption) {
                messageBody[mediaType].caption = caption;
            }

            // Add filename for documents
            if (mediaType === 'document' && filename) {
                messageBody[mediaType].filename = filename;
            }

            const response = await fetch(
                `https://graph.facebook.com/v18.0/${ctx.metaPhoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${ctx.accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(messageBody),
                }
            );

            const data = await response.json();
            whatsappMessageId = data.messages?.[0]?.id;

            if (!response.ok) {
                console.error('[Automation] Meta API error:', data);
            }
        }

        console.log('[Automation] Media message sent:', whatsappMessageId || 'no id');

        if (whatsappMessageId) {
            const { data: savedMessage, error: saveError } = await supabase
                .from('messages')
                .insert({
                    conversation_id: ctx.conversationId,
                    content: caption || filename || 'Arquivo',
                    direction: 'outbound',
                    whatsapp_message_id: whatsappMessageId,
                    // mediaType vem da CONFIG do fluxo (editável pelo usuário):
                    // fora da whitelist viraria 23514 e a mensagem sumia do CRM.
                    message_type: ['image', 'video', 'audio', 'document', 'sticker'].includes(mediaType) ? mediaType : 'document',
                    media_url: mediaUrl,
                    media_mime_type: mimeType,
                    media_filename: filename,
                    metadata: { automacao: true },
                })
                .select('id')
                .maybeSingle();

            if (saveError) {
                // O contato JÁ recebeu — insert falho = robô mudo no CRM.
                console.error('[Automation] Failed to save message (automation-media):', saveError);
                await logWriteFailure(supabase, {
                    toJid: String(ctx.contactPhone ?? ctx.conversationId),
                    wamid: whatsappMessageId,
                    action: 'msg_write_failed',
                    error: `${saveError.code ?? 'unknown'}: ${saveError.message}`,
                    route: 'automation-media',
                    payload: { conversation_id: ctx.conversationId, content: caption || filename || 'Arquivo', whatsapp_message_id: whatsappMessageId },
                });
            }

            if (savedMessage) {
                await emitMessageSent(supabase, {
                    conversationId: ctx.conversationId,
                    messageId: savedMessage.id,
                    whatsappMessageId,
                    content: caption || filename || 'Arquivo',
                    messageType: mediaType,
                    sentBy: null,
                    origin: 'automation',
                    phoneNumberDbId: ctx.phoneNumberDbId,
                    organizationId: ctx.organizationId,
                    metaPhoneNumberId: ctx.metaPhoneNumberId,
                    media: { url: mediaUrl, mime_type: mimeType, filename: filename },
                });
            }
        }
    } catch (error) {
        console.error('[Automation] Failed to send media message:', error);
    }
}

async function sendWebhookNode(
    supabase: SupabaseClient,
    ctx: ExecutionContext,
    nodeData: any,
    session: any
): Promise<void> {
    const url = nodeData.url;
    if (!url) {
        console.warn('[Automation] Webhook node missing URL, skipping');
        return;
    }

    try {
        console.log(`[Automation] Triggering custom webhook: ${url}`);

        const { data: conversation } = await supabase
            .from('conversations')
            .select(`
        *,
        contact_name,
        contact_phone,
        assigned_agent:assigned_to (
          id,
          email,
          first_name,
          last_name
        )
      `)
            .eq('id', ctx.conversationId)
            .single();

        // Get base64: use provided or download from URL
        let mediaBase64: string | null = ctx.message.mediaBase64 || null;
        if (!mediaBase64 && ctx.message.mediaUrl) {
            try {
                console.log(`[Automation] Downloading media for base64: ${ctx.message.mediaUrl}`);
                const mediaResponse = await fetch(paraUrlInterna(ctx.message.mediaUrl));
                if (mediaResponse.ok) {
                    const arrayBuffer = await mediaResponse.arrayBuffer();
                    const bytes = new Uint8Array(arrayBuffer);
                    let binary = '';
                    for (let i = 0; i < bytes.byteLength; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    mediaBase64 = btoa(binary);
                    console.log(`[Automation] Media converted to base64, length: ${mediaBase64.length}`);
                }
            } catch (e) {
                console.error('[Automation] Failed to download media for base64:', e);
            }
        }

        const payload = {
            event: 'automation.webhook_node',
            timestamp: new Date().toISOString(),
            organization_id: ctx.organizationId,
            conversation_id: ctx.conversationId,
            trigger_direction: ctx.triggerContext || 'inbound',
            contact: {
                name: conversation?.contact_name,
                phone: conversation?.contact_phone,
            },
            agent: conversation?.assigned_agent ? {
                id: conversation.assigned_agent.id,
                name: [conversation.assigned_agent.first_name, conversation.assigned_agent.last_name].filter(Boolean).join(' ') || 'Unknown',
                email: conversation.assigned_agent.email
            } : null,
            flow_id: session.flow_id,
            session_id: session.id,
            node_id: nodeData.id,
            context: session.context,
            last_message: {
                content: ctx.message.content,
                type: ctx.message.type,
                selectionId: ctx.message.selectionId,
                media: ctx.message.mediaUrl ? {
                    url: ctx.message.mediaUrl,
                    mime_type: ctx.message.mediaMimeType,
                    filename: ctx.message.mediaFilename,
                    base64: mediaBase64,
                } : null,
            },
        };

        // URL escolhida por quem monta o fluxo: passa pela guarda SSRF (fetchExterno) em cada salto.
        const response = await fetchExterno(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Echo-Automation-Webhook/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`[Automation] Webhook failed with status ${response.status}:`, await response.text());
        } else {
            console.log(`[Automation] Webhook sent successfully to ${url}`);
        }
    } catch (error) {
        if (error instanceof UrlExternaBloqueadaError) {
            console.warn(`[Automation] URL do webhook bloqueada pela guarda (${error.reason})`);
        } else {
            console.error('[Automation] Error sending custom webhook:', error);
        }
    }
}

async function updateSession(
    supabase: SupabaseClient,
    sessionId: string,
    nodeId: string
): Promise<void> {
    await supabase
        .from('automation_sessions')
        .update({
            current_node_id: nodeId,
            updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId);
}

async function updateSessionContext(
    supabase: SupabaseClient,
    sessionId: string,
    context: Record<string, unknown>
): Promise<void> {
    await supabase
        .from('automation_sessions')
        .update({
            context,
            updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId);
}

async function executeSurveyNode(
    supabase: SupabaseClient,
    node: FlowNode,
    nodes: FlowNode[],
    edges: FlowEdge[],
    session: any,
    ctx: ExecutionContext,
    logger: ExecutionLogger
): Promise<void> {
    const questions = node.data.questions || [];
    if (questions.length === 0) {
        logger.logNode(node.type, node.id, 'No questions configured, skipping');
        await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
        return;
    }

    const sessionContext = session.context || {};
    let surveyState = sessionContext.survey || null;

    if (!surveyState) {
        // First call — initialize survey state
        logger.logNode(node.type, node.id, 'Starting survey');
        const nowIso = new Date().toISOString();
        surveyState = {
            questionIndex: 0,
            answers: [],
            startedAt: nowIso,
            lastQuestionSentAt: nowIso,
            reminderSentAt: null,
        };
    } else {
        // Continuation — save user's answer to the current question
        const currentQ = questions[surveyState.questionIndex];
        if (currentQ) {
            surveyState.answers.push({
                questionId: currentQ.id,
                question: currentQ.message,
                answer: ctx.message.content,
                selectionId: ctx.message.selectionId || null,
                answeredAt: new Date().toISOString(),
            });
            logger.logNode(node.type, node.id,
                `Answer saved for "${currentQ.id}": "${ctx.message.content}"`);
            surveyState.questionIndex++;
        }

        // Check if 30 minutes have passed since survey started
        const elapsedMs = Date.now() - new Date(surveyState.startedAt || new Date()).getTime();
        const isTimedOut = elapsedMs > 30 * 60 * 1000; // 30 minutes in milliseconds
        if (isTimedOut && surveyState.questionIndex < questions.length) {
            logger.logNode(node.type, node.id, 'Survey timed out after 30 minutes, finalizing with partial answers');
            surveyState.questionIndex = questions.length; // Force to end section
        }
    }

    if (surveyState.questionIndex < questions.length) {
        // Send next question
        const nextQ = questions[surveyState.questionIndex];
        logger.logNode(node.type, node.id,
            `Sending question ${surveyState.questionIndex + 1}/${questions.length}`);

        if (nextQ.type === 'list' && nextQ.listConfig) {
            await sendListMessage(supabase, ctx, {
                body: nextQ.message,
                buttonText: nextQ.listConfig.buttonText || 'Ver opções',
                sections: nextQ.listConfig.sections || [],
            });
        } else {
            await sendTextMessage(supabase, ctx, nextQ.message);
        }

        // Re-arm reminder: track when this question was sent, clear any prior reminder flag
        surveyState.lastQuestionSentAt = new Date().toISOString();
        surveyState.reminderSentAt = null;

        // Save survey state and pause at this node
        const updatedContext = { ...sessionContext, survey: surveyState };
        session.context = updatedContext;
        await updateSessionContext(supabase, session.id, updatedContext);
        await updateSession(supabase, session.id, node.id);
        await logger.updateLog();
    } else {
        // All questions answered
        logger.logNode(node.type, node.id, 'Survey complete', {
            survey_completed: {
                label: node.data.label,
                questions: node.data.questions,
                answers: surveyState.answers,
            },
        });

        if (node.data.completionMessage) {
            await sendTextMessage(supabase, ctx, node.data.completionMessage);
            logger.logNode(node.type, node.id, 'Completion message sent');
        }

        if (node.data.webhookUrl) {
            await sendSurveyWebhook(supabase, ctx, node, session, surveyState);
            logger.logNode(node.type, node.id, 'Survey webhook sent');
        }

        // Clean survey from context
        const cleanedContext = { ...sessionContext };
        delete cleanedContext.survey;
        session.context = cleanedContext;
        await updateSessionContext(supabase, session.id, cleanedContext);

        await moveToNextNode(supabase, node, nodes, edges, session, ctx, logger);
    }
}

async function sendSurveyWebhook(
    supabase: SupabaseClient,
    ctx: ExecutionContext,
    node: FlowNode,
    session: any,
    surveyState: { questionIndex: number; answers: Array<{ questionId: string; question: string; answer: string; selectionId: string | null; answeredAt: string }> }
): Promise<void> {
    const url = node.data.webhookUrl;
    if (!url) return;

    try {
        const { data: conversation } = await supabase
            .from('conversations')
            .select('contact_name, contact_phone')
            .eq('id', ctx.conversationId)
            .single();

        const payload = {
            event: 'automation.survey_completed',
            timestamp: new Date().toISOString(),
            organization_id: ctx.organizationId,
            conversation_id: ctx.conversationId,
            flow_id: session.flow_id,
            session_id: session.id,
            node_id: node.id,
            contact: {
                name: conversation?.contact_name,
                phone: conversation?.contact_phone,
            },
            survey: {
                questions: node.data.questions,
                answers: surveyState.answers,
            },
        };

        // Mesma regra do nó de webhook: URL de quem monta o fluxo passa pela guarda SSRF.
        const response = await fetchExterno(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Echo-Automation-Survey/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`[Automation] Survey webhook failed: ${response.status}`, await response.text());
        } else {
            console.log(`[Automation] Survey webhook sent to ${url}`);
        }
    } catch (error) {
        if (error instanceof UrlExternaBloqueadaError) {
            console.warn(`[Automation] URL do webhook da pesquisa bloqueada pela guarda (${error.reason})`);
        } else {
            console.error('[Automation] Error sending survey webhook:', error);
        }
    }
}

async function endSession(
    supabase: SupabaseClient,
    sessionId: string,
    status: 'completed' | 'cancelled',
    logger: ExecutionLogger
): Promise<void> {
    logger.log('success', `Flow ${status.toUpperCase()}`, { details: { session_id: sessionId } });

    await supabase
        .from('automation_sessions')
        .update({
            status,
            updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId);

    // Complete the execution log
    await logger.complete(status);
}

function isWithinBusinessHours(data: any): boolean {
    const startTime = data.startTime || "09:00";
    const endTime = data.endTime || "18:00";
    const days = data.days || ["1", "2", "3", "4", "5"];

    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const brazilTime = new Date(utcTime + (3600000 * -3));

    const day = brazilTime.getDay().toString();
    const currentTime = `${brazilTime.getHours().toString().padStart(2, '0')}:${brazilTime.getMinutes().toString().padStart(2, '0')}`;

    console.log(`[Automation] Checking hours: Current=${currentTime} Day=${day}, Config: ${startTime}-${endTime} Days=[${days.join(',')}]`);

    if (!days.includes(day)) return false;

    return currentTime >= startTime && currentTime <= endTime;
}
