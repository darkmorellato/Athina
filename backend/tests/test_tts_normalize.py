# -*- coding: utf-8 -*-
"""Testes da normalização pt-BR para TTS (backend/tts_normalize.py).

Rodar:  backend/.venv/bin/python backend/tests/test_tts_normalize.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tts_normalize import normalize_pt_br  # noqa: E402

CASES: list[tuple[str, str, list[str], list[str]]] = [
    # (entrada, descrição, substrings esperadas, substrings proibidas)
    (
        "R$ 1.234,56",
        "moeda com milhar",
        ["mil duzentos e trinta e quatro reais", "cinquenta e seis centavos"],
        ["dólar", "R$", "vírgula", "dolar"],
    ),
    (
        "R$ 89,90",
        "moeda simples",
        ["oitenta e nove reais e noventa centavos"],
        ["dólar", "vírgula"],
    ),
    (
        "R$ 0,50",
        "centavos sem reais",
        ["cinquenta centavos"],
        ["zero reais", "dólar"],
    ),
    (
        "R$ 1,00",
        "um real (singular)",
        ["um real"],
        ["um reais", "dólar"],
    ),
    (
        "CPF: 123.456.789-01",
        "CPF formatado dígito a dígito",
        ["um dois três,", "zero um"],
        ["milhões", "menos", "ponto"],
    ),
    (
        "12.345.678/0001-99",
        "CNPJ formatado",
        ["um dois, três quatro cinco", "nove nove"],
        ["milhões", "menos"],
    ),
    (
        "IMEI 356789012345678",
        "IMEI 15 dígitos falado",
        ["três cinco seis", "seis sete oito"],
        ["mil", "trilhão"],
    ),
    (
        "vence em 05/11/2026",
        "data completa",
        ["cinco de novembro de dois mil e vinte e seis"],
        ["barra", "zero cinco"],
    ),
    (
        "vence em 05/11",
        "data sem ano",
        ["cinco de novembro"],
        ["barra"],
    ),
    (
        "as 14:30",
        "horário com meia",
        ["catorze horas e meia"],
        ["quatorze", "dois pontos"],
    ),
    (
        "as 09:05",
        "horário com minutos",
        ["nove horas e cinco"],
        [],
    ),
    (
        "das 14h às 18h30",
        "horário sufixo h",
        ["catorze horas", "dezoito horas e meia"],
        ["h30", "14h"],
    ),
    (
        "parcela de 24x de R$ 104,17",
        "parcelas vezes + moeda",
        ["vinte e quatro vezes", "cento e quatro reais e dezessete centavos"],
        ["xis", "dólar", "vírgula"],
    ),
    (
        "*Importante*: _verifique_ o codigo ~agora~",
        "markdown do WhatsApp",
        ["Importante", "verifique", "codigo", "agora"],
        ["asterisco", "*", "~", "_"],
    ),
    (
        "Ola! \U0001f600\U0001f60a",
        "emojis removidos",
        ["Ola!"],
        ["rosto", "risonho", "\U0001f600"],
    ),
    (
        "PIX, CPF, IMEI, WhatsApp, Nuovopay",
        "siglas",
        ["pix", "Uatsapi"],
        ["peixis"],
    ),
    (
        "Segue o código copia e cola:\n00020126580014BR.GOV.BCB.PIX0136123ab456c789d0123456789012345678905204000053039865802BR5913NOMEDALOJALTDA6009SAOPAULO62070503***6304ABCD",
        "código PIX longo nao é lido",
        ["código"],
        ["zero zero zero dois", "BR.GOV", "LTDA", "ABCD", "SAOPAULO"],
    ),
    (
        "Código PIX:\n00020126580014 BR.GOV.BCB.PIX 0136123ab456c789d0123456789012345678905204 000053039865802BR5913NOMEDALOJA\nPronto.",
        "código PIX quebrado em partes",
        ["Código pix:", "código", "Pronto."],
        ["NOMEDALOJA", "zero zero zero dois", "BR.GOV"],
    ),
    (
        "valor de 1.500,00 reais",
        "valor com centavos sem R$",
        ["mil e quinhentos reais"],
        ["vírgula", "zero"],
    ),
    (
        "telefone (11) 98765-4321",
        "telefone com hífen",
        ["onze", "nove oito sete seis cinco, quatro três dois um"],
        ["menos", "mil setecentos"],
    ),
    (
        "acesse o site e o app",
        "léxico site/app",
        ["sáite"],
        [],
    ),
    (
        "50% de desconto",
        "porcentagem",
        ["cinquenta por cento"],
        ["%"],
    ),
    (
        "1-Sim  2-Não",
        "atalhos numerados",
        ["um, Sim", "dois, Não"],
        ["um-Sim"],
    ),
    (
        "CPF: ***.456.789-**",
        "máscara de CPF nao vira número",
        [],
        ["quatrocentos", "asterisco", "***"],
    ),
    (
        "Seu boleto de R$ 89,90 vence em 05/11/2026. CPF: 123.456.789-01. WhatsApp.",
        "frase completa do fluxo",
        [
            "oitenta e nove reais e noventa centavos",
            "cinco de novembro de dois mil e vinte e seis",
            "um dois três,",
            "Uatsapi",
        ],
        ["dólar", "menos", "milhões", "barra", "asterisco", "R$"],
    ),
    (
        "Ola! Tudo bem?",
        "texto simples inalterado",
        ["Ola! Tudo bem?"],
        [],
    ),
]


def main() -> int:
    failures = 0
    for entry, desc, must, forbid in CASES:
        out = normalize_pt_br(entry)
        problems = [f"faltou {s!r}" for s in must if s not in out]
        problems += [f"proibido {s!r}" for s in forbid if s in out]
        # idempotência
        out2 = normalize_pt_br(out)
        if out2 != out:
            problems.append(f"não idempotente: {out2!r} != {out!r}")
        if problems:
            failures += 1
            print(f"FALHOU [{desc}] entrada={entry!r}")
            print(f"        saida={out!r}")
            for p in problems:
                print(f"        - {p}")
        else:
            print(f"ok [{desc}]: {out!r}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} casos passaram")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
