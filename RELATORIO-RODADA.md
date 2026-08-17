# Relatório de Correções — Rodada de Melhorias Milhão Door

**Data:** 2026-08-17  
**Status:** ✅ Concluído (sem commit/push/deploy)

---

## 1. Backend (server.js)

### 1.1 Propriedade de Espaços
- **`/api/link`** agora usa `authOpcional` + `usuarioEhDonoEspaco()` — valida propriedade real via `usuarioId` ou `orderToken`, não mais apenas token no body.
- **`/api/test/reserve`** agora grava `usuarioId: req.usuario.id` nos espaços criados em modo teste, permitindo que "MEUS ESPAÇOS COMPRADOS" funcione para compras logadas.

### 1.2 Upload / Multer
- Erros Multer localizados em PT-BR: `LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`, `LIMIT_UNEXPECTED_FILE`, `LIMIT_FIELD_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_PART_COUNT`.

### 1.3 Story/Destaque Billing
- **Tabela `destaques`** criada (id, usuario_id, tipo, duracao, preco_cents, status, order_id, mp_order_id, payment_id, metodo_pagamento, titulo, subtitulo, publicado, criado_em, pago_em, expira_em).
- **`story_events.usuario_id`** ALTER adicionado.
- **`registrarStoryEvento`** agora aceita `usuarioId` + `expiresAt`.
- **Funções novas:**
  - `processarPagamentoDestaque({mpOrderId, totalCents})` — valida preco_cents, ativa com expira_em, auto-publica se título presente.
  - `publicarDestaque(destaqueId)` — upsert story com `eventKey: destaque:<id>`.
  - `expirarDestaquesVencidos()` — marca destaques expirados + limpa story_events vencidos.
- **Rotas:**
  - `POST /api/stories/destaques` — cria destaque pendente, cobra via MP.
  - `GET /api/stories/destaques/meus` — lista destaques do usuário logado.
  - `GET /api/stories/destaques/:id` — consulta status (poll MP se pendente).
  - `POST /api/stories/destaques/:id/publicar` — publica/atualiza conteúdo.
- **Webhook** `/webhooks/mercadopago` agora chama `processarPagamentoDestaque` após combos.
- **Intervalo** `setInterval(expirarDestaquesVencidos, 30_000)` em `initBanco().then()`.

### 1.4 Esqueci Minha Senha
- **Tabela `senha_recuperacoes`** (id, usuario_id, token_hash, expira_em, usada_em, criado_em).
- **`POST /api/auth/senha-recuperacao`** — valida email, gera token (30 min), envia link para `/redefinir-senha.html?token=...`. Resposta genérica (não revela se email existe). Em modo teste (`ALLOW_TEST_MODE` + header `x-test-mode: 1`), retorna `testeToken`.
- **`POST /api/auth/redefinir-senha`** — valida token hash, expiração, uso único; atualiza `senha_hash` via `hashSenha`; marca token como usado; insere chave de logout em `usuario_chaves` para revogar sessões.

### 1.5 Correções
- **`duracaoLabel`** corrigido: `"5h"` → `"5 horas"` (antes produzia `"5 horah"`).
- **Poll route** (`GET /api/stories/destaques/:id`): removido `paraCentavos()` duplo — `ordem.total_amount` já vem em centavos do MP.

---

## 2. Backend (colecionaveis.js)

### 2.1 Chat Conversas
- **`GET /api/colecionaveis/chat/conversas`** — lista conversas do usuário logado (vendedor ou comprador), com `vendedorNome` (via JOIN `usuarios v ON v.id = c.seller_id`) e contagem de não lidas calculada em JS.

### 2.2 Oferta Pay Resume
- **`POST /offers/:id/pay`** agora aceita status `ACEITA` **e** `AGUARDANDO_PAGAMENTO` para retomar pagamento.

---

## 3. Frontend (index.html)

### 3.1 Esqueci Minha Senha
- Link "Esqueci minha senha" no modal de login.
- Funções: `abrirModalEsqueciSenha`, `criarModalRecuperar`, `voltarDoEsqueciSenha`, `enviarEsqueciSenha`.
- Usa `#authRecuperar` div injetado no modal.

### 3.2 MEUS ESPAÇOS COMPRADOS
- **`carregarMeusEspacos`** agora busca `/api/combos/kits/beneficios` e renderiza benefícios pendentes com botão "🎯 ESCOLHER ESPAÇOS" em novo div `#beneficiosPendentes` (após `#ownerList`).
- Helper `escAttr` para escapar atributos HTML.

### 3.3 Destaque Purchase UI
- **`abrirDestaqueStory()`** reescrito: requer login, mostra modal com seleção de duração (5h/7h/12h/24h + preços), campos título/subtítulo, CPF, botão "💳 PAGAR COM PIX" e "📅 MEUS DESTAQUES".
- **`confirmarCompraDestaque()`** — POST `/api/stories/destaques`, renderiza QR/payload, inicia polling 5s.
- **`renderizarPagamentoDestaque(data)`** — mostra QR code (base64), payload copiar, status, botão "Já paguei o PIX".
- **`verificarDestaquePagamento(id)`** — polling GET `/api/stories/destaques/:id`, ao confirmar → mostra sucesso + botão MEUS DESTAQUES.
- **`abrirMeusDestaques()`** — GET `/api/stories/destaques/meus`, lista com status/tempo restante, botões PUBLICAR/EDITAR/COMPRAR NOVAMENTE.
- **`editarPublicarDestaque(id)`** — formulário título/subtítulo → POST `/:id/publicar`.
- **`toastMsg(m)`** — toast flutuante genérico (position fixed bottom).

---

## 4. Frontend (colecionaveis.html)

### 4.1 Modal CSS Fix
- Frente do modal mostra só arte (`.cc-info` oculto na frente), verso rola internamente, arte flex-fills sem sobrepor nome/descrição/botões.

### 4.2 Listing HTML Rewrite
- **`listingHtml`** reescrito: badges RESERVADA/parcial, COMPRAR desabilitado quando reservado, botão 💬 CHAT (`abrirChatAnuncio`), fluxo dono com "👀 Ver interessados" (`verInteressados`), CSS `.listing-acoes`/`.listing-badge`.

### 4.3 Chat UI
- **`abrirChatAnuncio`** — seletor de interessados (vendedor sem buyerId), cabeçalho com arte/figurinha/preço/vendedor, status da oferta, ações COMPRAR/FAZER OFERTA, Enter-to-send.
- **`enviarChatAnuncio`** — reabre com `marcarLido=1`.
- **`abrirMeusChats()`** — lista conversas com badge de não lidas.
- CSS: `.chat-contexto`, `.chat-oferta`, `.chat-acoes`, `.chat-naolidas`.

### 4.4 Oferta States UI
- **`renderOfertaHtml`** atualizado: labels CONTRAPROPOSTA/AGUARDANDO_PAGAMENTO/PAGA, botão PAGAR em ACEITA/AGUARDANDO_PAGAMENTO, dica CONTRAPROPOSTA para ofertas enviadas, nota PAGA.

### 4.5 Smart Polling
- **`iniciarPollingColecionaveis()`** — intervalo 15s, refresh da aba ativa (mercado/ofertas/leiloes/trocas/acervo), pausa em `document.visibilityState !== "visible"`, handler `visibilitychange`.

### 4.6 Fila Determinística de Revelação
- Auto mode timers reduzidos: slotBack 750ms (auto) vs 8000 (manual), reveal 1500ms (auto) vs 6500, pack grande → resumo 3200ms (auto) vs 9000.

### 4.7 Header Logado
- **`atualizarHeader`** mostra "🔐 nome" quando logado. CSS `.conta-nome`.

### 4.8 Esqueci Minha Senha
- Link "Esqueci minha senha" no modal de login.
- Funções: `abrirModalEsqueciSenha`, `enviarEsqueciSenha`.

### 4.9 Perfil Session Bar
- Div `#sessaoBar` em `#secao-perfil`.
- **`carregarPerfil`** renderiza barra de sessão com nome/email + botão logout.
- **`sairConta()`** — limpa localStorage, chama `/api/auth/logout`, volta para aba álbum.
- CSS `.sessao-bar`.

---

## 5. Nova Página: redefinir-senha.html

- Lê `?token=` da URL, valida presença.
- Formulário: nova senha (mín. 6), confirmação.
- POST `/api/auth/redefinir-senha`.
- Estados: sucesso (link para login) / erro (mensagem).
- Tema da marca (mesmo CSS de index.html).

---

## 6. Testes

### 6.1 test-rotina-avancada.js (38 cenários)
- **Auth + senha:** registro, login, /me, recuperação (email inexistente/existente + testeToken), redefinir (válido/usado/inválido/fraco).
- **Espaços:** reserva test mode, status paid, usuarioId, /api/link (dono/outro).
- **Destaques:** validações (auth/duração/CPF/título), criação, totalCents, meus destaques (isolamento), GET/:id, publicar pendente → 403, GET de outro → 404.
- **Colecionáveis:** cards, oferta PENDENTE, contraproposta, CONTRAPROPOSTA, chat conversas.
- **Config:** /api/config, /api/stories/config, diagnóstico sem tokens.

### 6.2 test-financeiro.js (69 validações)
- **Regra 90/10 em centavos inteiros** para preços: 15, 20, 45, 50, 99.99, 100, 1000.
- Valida: feeCents inteiro, netSellerCents inteiro, fee + net === total, fee ≈ 10% (±1), net ≈ 90% (±1), conversão reais consistente, fee + net === total (reais).
- Casos extras: 0.01, 0.10, 1.01, 10.10, 100.01.
- **taxaDoSite:** validação para preços em reais (inteiro em centavos, ≈ 10%).

### 6.3 Resultados
```
test-stories.js:          6/6   ✅
test-col-ofertas.js:     27/27  ✅
test-col-pacotes.js:      8/8   ✅
test-rotina-avancada.js: 38/38  ✅
test-financeiro.js:      69/69  ✅
─────────────────────────────────
TOTAL:                  148/148 ✅
```

---

## 7. Playwright (Desktop/Mobile)

- **Viewport 1366x768** (desktop) e **390x844** (mobile).
- Valida: sem overflow horizontal, sem `[object Object]`, sem imagens quebradas.
- Screenshot: `C:\Users\MARCUS~1\AppData\Local\Temp\megaoutdoor-playwright\colecionaveis-mobile.png`.
- **Resultado:** ✅ PASS

---

## 8. Arquivos Modificados

### Backend
- `server.js` — link ownership, multer errors, destaques, senha_recuperacoes, webhook, test/reserve usuarioId, correções.
- `colecionaveis.js` — chat conversas, offer pay resume.

### Frontend
- `public/index.html` — esqueci senha, MEUS ESPAÇOS benefícios, Destaque UI.
- `public/colecionaveis.html` — modal CSS, listing, chat, ofertas, polling, reveal, header, perfil.
- `public/redefinir-senha.html` — **NOVO**.

### Testes
- `test-rotina-avancada.js` — **NOVO** (38 cenários).
- `test-financeiro.js` — **NOVO** (69 validações).
- `test-col-ofertas.js` — atualizado (linha 170: CONTRAPROPOSTA em vez de RECUSADA).

---

## 9. Próximos Passos (Opcionais)

1. **Playwright expandido** — adicionar testes de interação (cliques, formulários) além da auditoria visual estática.
2. **Cobertura de testes** — adicionar cenários para:
   - Destaque pagamento real (mock MP completo).
   - Oferta CONTRAPROPOSTA aceite + pagamento.
   - Chat mensagens (enviar/receber).
3. **Documentação** — atualizar README com novas rotas (`/api/stories/destaques/*`, `/api/auth/senha-recuperacao`, `/api/auth/redefinir-senha`).
4. **Deploy** — após revisão, commit + push + deploy em sandbox.

---

## 10. Notas Técnicas

- **Sem commit/push/deploy** — aguardando autorização do usuário.
- **Sem pagamento fictício** — todos os fluxos usam MP sandbox ou teste via `ALLOW_TEST_MODE`.
- **Sem quebra de compatibilidade** — rotas existentes mantidas, novas rotas adicionadas.
- **Inteiro em centavos** — toda matemática financeira usa `Math.round()` para evitar floats.
- **Segurança** — tokens de recuperação com hash (sha256), expiração 30min, uso único.
- **Test mode hook** — `x-test-mode: 1` + `ALLOW_TEST_MODE` retorna `testeToken` para automação.

---

**Fim do relatório.**
