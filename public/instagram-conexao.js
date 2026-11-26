// Página de retorno do login do Instagram (função instagram-oauth do Echo).
// Arquivo separado porque a CSP do Echo só aceita script do próprio domínio.
(function () {
  var q = new URLSearchParams(location.search);
  var conta = q.get('conta') ? '@' + q.get('conta') : 'A conta do Instagram';
  var textos = {
    ok: ['Instagram ligado ao Echo', conta + ' está ligada ao Echo. Ninguém de fora vê diferença. Pode fechar esta aba.'],
    'sem-avisos': ['Ligado, mas sem avisos', conta + ' foi ligada, mas o Instagram não aceitou mandar os avisos de mensagem. A equipe técnica já tem o motivo.'],
    cancelado: ['Conexão cancelada', 'A autorização do Instagram não foi concedida. Nada foi alterado.'],
    'link-invalido': ['Link vencido ou inválido', 'Peça um novo link de conexão. Nada foi alterado.'],
    indisponivel: ['Conexão indisponível', 'O Echo ainda não tem os dados do app do Instagram. Nada foi alterado.'],
    linha: ['Linha não encontrada', 'A linha do Echo deste link não existe mais. Nada foi alterado.'],
    recusado: ['Não deu para conectar', 'O Instagram recusou a autorização. Nada foi alterado.'],
    'outra-linha': ['Não deu para conectar', 'Esta conta do Instagram já está ligada a outra linha do Echo. Nada foi alterado.'],
    'linha-ocupada': ['Não deu para conectar', 'Essa linha do Echo já divide a caixa com outra conta do Instagram. Nada foi alterado.'],
    erro: ['Não deu para conectar', 'O Echo não conseguiu guardar a conexão. Tente de novo em alguns minutos.']
  };
  var t = textos[q.get('r')] || ['Instagram no Echo', 'Endereço sem resultado. Use o link de conexão enviado pela equipe.'];
  document.getElementById('titulo').textContent = t[0];
  document.getElementById('texto').textContent = t[1];
  document.title = t[0];
})();
