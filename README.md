# ASTRO

Harness single-agent em Bun/TypeScript para executar tarefas de código com tools,
ledger de uso e auditoria append-only. Esta é a F2 do projeto: um agente, três
providers iniciais (NVIDIA NIM, OpenRouter e Codex OAuth) e zero dependências de
runtime.

## Requisitos

- [Bun](https://bun.sh) instalado.
- Uma chave de API da NVIDIA (`NVIDIA_API_KEY`) ou do OpenRouter
  (`OPENROUTER_API_KEY`), ou uma sessão do Codex já autenticada em
  `~/.codex/auth.json`.
- Nenhum segredo vai no arquivo de configuração: a config guarda apenas o
  **nome** da variável de ambiente (`credentialRef`).

## Configuração

Copie o exemplo:

```bash
cp astro.config.example.json astro.config.json
```

No PowerShell:

```powershell
Copy-Item astro.config.example.json astro.config.json
```

Exporte a chave do provider que será usado:

```bash
export NVIDIA_API_KEY="..."      # Linux/macOS
export OPENROUTER_API_KEY="..."
```

```powershell
$env:NVIDIA_API_KEY = "..."      # PowerShell
$env:OPENROUTER_API_KEY = "..."
```

O exemplo já vem com um modelo de cada provider. O modelo usado pelo agente é
escolhido em `agent.model` no formato `<provider>/<id>`:

- NVIDIA NIM: `nvidia/meta/llama-3.3-70b-instruct`
- OpenRouter: `openrouter/openai/gpt-4o-mini`
- Codex OAuth: `codex/gpt-5.5`

As tags de cada modelo pertencem ao vocabulário fechado de `src/tags.ts`; uma tag
desconhecida (ou um modelo/provider ausente) faz a config falhar com `ConfigError`.

### Custo e preço

`price` é opcional por modelo. Sem preço curado, o ledger grava `costUsd: null`,
o console avisa e o resumo do CLI mostra `n/d` — esse é o comportamento previsto
na spec. Para estimar custo, acrescente ao modelo:

```json
"price": { "inputPerM": 1.5, "outputPerM": 6, "fonte": "tabela do provider", "verificado": false }
```

Mantenha `verificado: false` enquanto o valor não tiver sido conferido na fonte.

## Rodando

```bash
bun src/cli.ts run "crie um hello.ts que exporta hello()"
```

Opções:

```bash
bun src/cli.ts run "<pedido>" --config astro.config.json --cwd ./work
bun src/cli.ts --help
```

- `--config` aponta para a config (default: `astro.config.json` no diretório em
  que o CLI foi chamado).
- `--cwd` é o diretório de trabalho do agente e a base dos caminhos relativos de
  `paths.ledger`/`paths.audit` (default: diretório atual).
- Sem argumentos ou com opção inválida, o CLI imprime o uso e sai com código 1.
- Em sucesso, imprime a resposta final e uma linha de resumo:
  `modelo · tokens · custo · ledger · auditoria`.

As tools disponíveis são `read_file`, `write_file`, `run_command`, `grep` e `list_dir`. Apenas as
tools listadas em `agent.tools` são expostas ao modelo; caminhos de arquivo são
confinados ao `--cwd` e `run_command` tem timeout.

## Smoke manual por provider

Os testes automatizados usam um servidor HTTP local (nunca chamam provider real).
Para validar credenciais de verdade, rode uma vez por provider:

1. **NVIDIA NIM**
   ```bash
   export NVIDIA_API_KEY="..."
   bun src/cli.ts run "diga oi"
   ```
   Com `agent.model` em `nvidia/meta/llama-3.3-70b-instruct`. Se a variável não
   estiver no ambiente, a execução falha antes de qualquer chamada com
   `erro: defina NVIDIA_API_KEY no ambiente`.

2. **OpenRouter**
   ```bash
   export OPENROUTER_API_KEY="..."
   bun src/cli.ts run "diga oi"
   ```
   Com `agent.model` em `openrouter/openai/gpt-4o-mini`. A ausência da variável
   produz `erro: defina OPENROUTER_API_KEY no ambiente`.

3. **Codex OAuth**
   ```bash
   bun src/cli.ts run "diga oi"
   ```
   Com `agent.model` em `codex/gpt-5.5`, sem exportar chave: o provider lê
   `~/.codex/auth.json` (gerado pelo login do Codex CLI). Arquivo ausente ou
   inválido gera erro de autenticação claro antes da chamada, citando apenas o
   caminho.

Para trocar de provider, edite `agent.model` em `astro.config.json` e repita o
comando. O ledger/auditoria de cada execução fica em `.astro/`.

## Segurança

- **Chave só no ambiente.** O valor nunca é lido da config, nem gravado em log,
  ledger ou auditoria; a config contém só o nome da variável (`credentialRef`).
- **Prompt não persistido.** `run.started` guarda apenas um `taskHash` SHA-256
  curto da tarefa, não o texto do pedido.
- **Auditoria sanitizada.** Eventos são JSONL append-only com `seq`/`ts`; chaves
  e valores com formato de segredo são redigidos. Eventos registram nomes de
  tools e `isError`, não argumentos nem resultados.
- **Codex somente leitura.** `~/.codex/auth.json` é lido, nunca escrito; a
  renovação de token acontece apenas em memória.
- **`.astro/` fora do git.** Ledger e auditoria ficam em `.astro/`, já coberto
  pelo `.gitignore`. Não versione `astro.config.json` com dados pessoais.
- A mensagem de chave ausente cita o **nome** da variável (ex.: `TEST_KEY`), nunca
  o valor.

## Testes

```bash
bun test
bun run typecheck
```

Os testes automatizados usam `Bun.serve` como provider mock e diretórios
temporários; não há chamadas reais nem credenciais reais.

## Licença

MIT — veja [`LICENSE`](LICENSE).
