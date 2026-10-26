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
Revise o diff e crie um commit no formato `tipo: resumo`. Pedido: $ARGUMENTS
