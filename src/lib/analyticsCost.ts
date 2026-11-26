// Custos estimados (não oficiais) por mensagem no Analytics.
export const TEMPLATE_COST = 0.31; // por mensagem de template entregue
export const API_COST = 0.04; // por mensagem fora de template enviada por número business_api
// As primeiras mensagens de API do mês não são cobradas.
export const FREE_API_MESSAGES = 1000;

export interface CostBreakdown {
    templateCost: number;
    apiCost: number;
    totalCost: number;
    billableApiMessages: number;
    freeApiMessagesUsed: number;
}

export function computeCost(templateMessages: number, apiMessages: number): CostBreakdown {
    const freeApiMessagesUsed = Math.min(Math.max(apiMessages, 0), FREE_API_MESSAGES);
    const billableApiMessages = Math.max(apiMessages - FREE_API_MESSAGES, 0);
    const templateCost = Math.max(templateMessages, 0) * TEMPLATE_COST;
    const apiCost = billableApiMessages * API_COST;
    return { templateCost, apiCost, totalCost: templateCost + apiCost, billableApiMessages, freeApiMessagesUsed };
}
