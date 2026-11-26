-- Dados de referência obrigatórios.
-- Parte do baseline do Echo. Mudança de esquema vai numa migração nova, não nesta.

-- Modelos de aviso do sistema (system_alerts), todos inativos. Para exibir um no banner do app, ative-o por SQL:
--   update public.system_alerts set is_active = true where title = '<título>';
-- O banner (hook useSystemAlerts) lê só os ativos. Idempotente: não repete um modelo que já exista com o mesmo título.
INSERT INTO public.system_alerts (title, message, severity, is_active)
SELECT v.title, v.message, v.severity, false
FROM (VALUES
    -- critical (vermelho): problema sério, pede atenção imediata
    ('API Indisponível',        'WhatsApp API está fora do ar. Mensagens não estão sendo enviadas.',         'critical'),
    ('Instabilidade no Sistema', 'Detectamos lentidão no sistema. Equipe trabalhando na correção.',          'critical'),
    ('Limite Atingido',         'Limite de envio de mensagens atingido. Contate o administrador.',           'critical'),
    ('Falha de Conexão',        'Conexão com WhatsApp perdida. Reconectando automaticamente.',               'critical'),
    -- warning (amarelo): aviso importante
    ('Manutenção Agendada',     'Manutenção programada para hoje às 23h. Duração estimada: 30min.',          'warning'),
    ('Nova Versão Disponível',  'Atualize o sistema para ter acesso às novas funcionalidades.',              'warning'),
    ('Lentidão Temporária',     'Algumas mensagens podem demorar mais para serem entregues.',                'warning'),
    ('Backup em Andamento',     'Backup do sistema em execução. Performance pode ser afetada.',              'warning'),
    ('Alta Demanda',            'Sistema com alta demanda. Tempo de resposta pode estar elevado.',           'warning'),
    -- normal (verde): informativo
    ('Sistema Operacional',     'Todos os sistemas funcionando normalmente.',                                'normal'),
    ('Novidade!',               'Nova funcionalidade disponível. Confira nas configurações.',                'normal'),
    ('Manutenção Concluída',    'Sistema atualizado com sucesso. Bom uso!',                                  'normal'),
    ('Dica do Dia',             'Use atalhos de teclado para agilizar seu atendimento.',                     'normal')
) AS v(title, message, severity)
WHERE NOT EXISTS (SELECT 1 FROM public.system_alerts s WHERE s.title = v.title);
