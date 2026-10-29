# ADR-0016: Identidade efetiva do agente no resume

- Status: aceita
- Data: 2026-10-29
- Issue: #163
- Decisões relacionadas: I-08, I-19, ADR-0002, ADR-0009

## Contexto

`astro resume` comparava apenas o **id** do modelo gravado com a config atual. Se a config
trocasse o provider ou a credencial mantendo o id (`a/m1` → `b/m1`, `KEY_A` → `KEY_B`), o run
retomava em outra conta/provider sem gate nem evento de troca — violação de I-08. O evento
`agent.created` gravava `model` e `profile`, mas não a identidade efetiva.

## Decisão

- `agent.created` passa a gravar `provider` e `credentialRef` (nome da variável, nunca o valor,
  I-03). `agent.identity` atualiza a identidade de um agente já ativo.
- `resume` compara provider, model e `credentialRef` gravados com a config. Divergência →
  `replay_incomplete`, antes de criar provider ou chamar a rede. Não há gate interativo nesta
  fatia: recusar é mais seguro que pedir aprovação para uma identidade que o ledger não descreve.
- Ledger antigo (sem `provider`/`credentialRef`) é aceito **uma vez**; o resume grava um evento
  `agent.identity` com a identidade atual, e a próxima retomada já compara.
- `run.started` também registra `provider` e `credentialRef` para leitura direta do audit.

## Consequências

- Troca silenciosa de provider/credencial em run retomado deixa de existir; o erro nomeia os dois
  lados e nunca o valor da chave.
- Ledgers antigos continuam retomáveis, com um evento extra na primeira retomada.
- `agentActive` considera `created` **ou** `identity` como agente vivo; só `destroyed` encerra.
- Quem lê o ledger ganha dois campos opcionais; consumidores antigos os ignoram.

## Alternativas descartadas

- Manter a comparação só por `id`: mantém a troca silenciosa.
- Gate `approveSwap` no resume: exigiria descrever a identidade original ao approver e um caminho
  interativo; fica para quando houver a identidade completa no `run_state` (follow-up).
