---
name: commit
description: Cria um commit com a mudança atual
version: 1.0.0
permissions:
  tools: [read_file, run_command]
  network: false
  filesystem: write
scripts:
  - name: status
    command: git status --short
---
Revise o diff do repositório e crie um commit convencional.

Passos:
1. Rode o script de status para ver o que mudou.
2. Leia os arquivos alterados relevantes.
3. Escreva uma mensagem no formato `tipo: resumo` com rodapé de referência à issue.

Detalhes do pedido: $ARGUMENTS
