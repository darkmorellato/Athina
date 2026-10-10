# -*- coding: utf-8 -*-
"""Normalização de texto pt-BR para TTS (Kokoro local e engines premium NVIDIA).

Por que existe: o espeak-ng (via kokoro-onnx) lê símbolos de forma imprevisível
em pt-BR — evidência coletada em 10/10/2026 com o fonemizador real do modelo:

  "R$ 1.234,56"        -> "xeˈaʊ dˈolar ..."      (fala "reau DÓLAR"!)
  "CPF: 123.456.789-01"-> "...milhões... menos zero um"
  "😀"                 -> "xˈostʊ xˌizˈoɲʊ"        (fala "rosto risonho")
  "*Importante*"       -> "æsteɾˈiskw ˈimpoɾətʃy"  (fala "asterisco")
  "24x"                -> "... ˈʃiz"               (fala "xis")
  "05/11/2026"         -> "zero cinco onze ..."    (sem o mês)
  "89,90"              -> "oitenta e nove vírgula noventa"

Este módulo expande tudo ANTES da síntese, para a fala sair natural. É aplicado
em ttsServer.py para TODOS os providers (Kokoro, Chatterbox, Magpie).

Invariantes:
- nunca inventa conteúdo (só reescreve o que existe);
- idempotente (normalizar duas vezes = mesma saída);
- nunca lança exceção (falha cai no texto original do trecho).
"""
from __future__ import annotations

import re
from typing import Callable

from num2words import num2words

# ─── Vocabulário ─────────────────────────────────────────────────────────────

_MONTHS = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]
_DIGIT_WORDS = {
    "0": "zero", "1": "um", "2": "dois", "3": "três", "4": "quatro",
    "5": "cinco", "6": "seis", "7": "sete", "8": "oito", "9": "nove",
}

# Siglas escritas de forma que o espeak as leia como palavra/pt-BR.
_LEXICON = [
    (re.compile(r"\bPIX\b", re.IGNORECASE), "pix"),
    (re.compile(r"\bsites\b", re.IGNORECASE), "sáites"),
    (re.compile(r"\bsite\b", re.IGNORECASE), "sáite"),
    (re.compile(r"\bWhatsApp\b", re.IGNORECASE), "Uatsapi"),
    (re.compile(r"\bWhats\b", re.IGNORECASE), "Uats"),
    (re.compile(r"\bnº\b", re.IGNORECASE), "número"),
]

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _cardinal(n: int) -> str:
    """Número por extenso pt-BR; remove a vírgula de separador de milhar."""
    return num2words(int(n), lang="pt_BR").replace(", ", " ")


def _spell_digits(s: str, sep: str = " ") -> str:
    return sep.join(_DIGIT_WORDS[c] for c in s if c.isdigit())


def _spell_grouped(s: str, sizes: list[int]) -> str:
    """Dígito a dígito com vírgulas nas fronteiras dos grupos (CPF/CNPJ)."""
    digits = [c for c in s if c.isdigit()]
    parts: list[str] = []
    i = 0
    for size in sizes:
        chunk = digits[i : i + size]
        if chunk:
            parts.append(" ".join(_DIGIT_WORDS[c] for c in chunk))
        i += size
    if i < len(digits):  # resto inesperado
        parts.append(" ".join(_DIGIT_WORDS[c] for c in digits[i:]))
    return ", ".join(parts)


def _spell_spaced_groups(s: str) -> str:
    """Dígito a dígito, vírgula a cada 3 dígitos da direita (telefone/IMEI)."""
    digits = [c for c in s if c.isdigit()]
    groups: list[str] = []
    while digits:
        take, digits = digits[-3:], digits[:-3]
        groups.append(" ".join(_DIGIT_WORDS[c] for c in take))
    return ", ".join(reversed(groups))


def _frac_words(frac: str) -> str:
    """Parte fracionária: com zero à esquerda fala dígito a dígito ('05' ->
    'zero cinco'); sem zero, cardinal ('56' -> 'cinquenta e seis')."""
    if frac.startswith("0"):
        return _spell_digits(frac)
    return _cardinal(int(frac))


def _money(whole: str, cents: str | None) -> str:
    whole_n = int(whole or "0")
    cents_n = int(cents) if cents else 0
    if whole_n == 0 and cents_n > 0:
        return f"{_cardinal(cents_n)} {'centavo' if cents_n == 1 else 'centavos'}"
    unit = "real" if whole_n == 1 else "reais"
    if not cents or cents_n == 0:
        return f"{_cardinal(whole_n)} {unit}"
    cents_unit = "centavo" if cents_n == 1 else "centavos"
    return f"{_cardinal(whole_n)} {unit} e {_cardinal(cents_n)} {cents_unit}"


def _date(day: str, month: str, year: str | None) -> str:
    d, m = int(day), int(month)
    if not (1 <= d <= 31 and 1 <= m <= 12):
        return day + "/" + month + ("/" + year if year else "")  # devolve cru
    out = f"{_cardinal(d)} de {_MONTHS[m - 1]}"
    if year:
        y = int(year)
        if y < 100:
            y += 2000
        out += f" de {_cardinal(y)}"
    return out


def _time(hh: str, mm: str | None) -> str:
    h = int(hh)
    out = f"{_cardinal(h)} {'hora' if h == 1 else 'horas'}"
    if mm is None:
        return out
    m = int(mm)
    if m == 0:
        return out
    if m == 30:
        return out + " e meia"
    return out + f" e {_cardinal(m)}"


# ─── Passos (aplicados na ordem) ─────────────────────────────────────────────


def _strip_urls(text: str) -> str:
    return re.sub(r"https?://\S+|www\.\S+", " ", text)


_MASKED_CPF = re.compile(r"\*{2,}\.\d{3}\.\d{3}-\*{1,2}|\*{3,}")


def _strip_masks(text: str) -> str:
    """Máscaras de CPF do sanitizeForWhatsApp (***.456.789-**) não devem ser
    lidas como número nem como 'asterisco'."""
    return _MASKED_CPF.sub(" ", text)


_EMOJI = re.compile(
    "["
    "\U0001f000-\U0001faff"  # pictogramas, emojis, bandeiras, símbolos
    "\u2600-\u27bf"  # símbolos diversos e dingbats
    "\u2b00-\u2bff"  # setas/símbolos suplementares
    "\ufe0f\u200d\ufe0e"  # variation selectors e ZWJ
    "\u2122\u2139\u24c2\u3030\u303d\u3297\u3299"
    "]+",
    flags=re.UNICODE,
)


def _strip_emoji(text: str) -> str:
    return _EMOJI.sub(" ", text)


def _strip_markdown(text: str) -> str:
    # formatação do WhatsApp (*negrito*, _itálico_, ~tachado~, `código`)
    text = re.sub(r"[*~`]", "", text)
    text = text.replace("_", " ")
    # cabeçalhos markdown no início de linha
    text = re.sub(r"(?m)^#{1,6}\s+", "", text)
    # marcadores de citação ("no início de linha)
    text = re.sub(r"(?m)^>\s?", "", text)
    # atalhos do agente "1-Sim" / "2-Não" -> "um, Sim"
    text = re.sub(r"\b(\d{1,2})-([A-Za-zÀ-ÿ])", r"\1, \2", text)
    return text


_LONG_CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9./+=*\-]{28,}[A-Za-z0-9]")
_LONG_CODE_DIGITS = re.compile(r"\d{11,}")


def _replace_long_codes(text: str) -> str:
    """Códigos PIX copia-e-cola / linhas digitáveis não são ditáveis —
    fala-se apenas 'código' (o texto completo continua na mensagem)."""

    def code(m: re.Match[str]) -> str:
        s = m.group(0)
        digits = sum(c.isdigit() for c in s)
        letters = sum(c.isalpha() for c in s)
        if digits >= 6 and letters >= 4:
            return "código"
        return s

    def digits(m: re.Match[str]) -> str:
        s = m.group(0)
        # 11..20 dígitos: CPF/CNPJ/IMEI/telefone — fala dígito a dígito
        if len(s) <= 20:
            return _spell_spaced_groups(s)
        return "código"

    text = _LONG_CODE.sub(code, text)
    text = _LONG_CODE_DIGITS.sub(digits, text)
    return text


_CODE_LINE_CHARS = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./+=*- "
)


def _replace_code_lines(text: str) -> str:
    """Linha inteira com cara de código (EMV PIX quebrado em partes com
    espaços): vira só 'código'. Exige ≥15 dígitos, ≥4 letras e nenhum
    caractere típico de frase (vírgula, acento, parêntese...) — protege
    texto normal de falso-positivo."""
    out: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if len(s) >= 40 and all(c in _CODE_LINE_CHARS for c in s):
            digits = sum(c.isdigit() for c in s)
            letters = sum(c.isalpha() for c in s)
            if digits >= 15 and letters >= 4:
                out.append("código")
                continue
        out.append(line)
    return "\n".join(out)


_MONEY = re.compile(r"R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?")
# Valor com centavos SEM o R$ (1.500,00 ["reais"]) — no domínio é dinheiro
_MONEY_BARE = re.compile(
    r"\b(\d{1,3}(?:\.\d{3})+),(\d{2})\b\s*(?:reais\b)?", re.IGNORECASE
)
# Telefone com hífen (98765-4321) — dígito a dígito, nunca "menos quatro mil"
_PHONE_HYPHEN = re.compile(r"\b(\d{4,5})-(\d{4,5})\b")
_CPF_FMT = re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b")
_CNPJ_FMT = re.compile(r"\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b")
_DATE = re.compile(r"\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b")
_TIME = re.compile(r"\b(\d{1,2}):(\d{2})\b")
_H_TIME = re.compile(r"\b(\d{1,2})h(\d{2})?\b")
_PERCENT = re.compile(r"\b(\d{1,3}(?:,\d+)?)\s*%")
_TIMES_X = re.compile(r"\b(\d{1,4})\s*[xX](?=\s|$|[,.;:!?])")
_THOUSANDS = re.compile(r"\b\d{1,3}(?:\.\d{3})+\b")
_DECIMAL = re.compile(r"\b(\d+),(\d+)\b")
_INT = re.compile(r"\d+")


def _apply(text: str, pattern: re.Pattern[str], fn: Callable[[re.Match[str]], str]) -> str:
    return pattern.sub(fn, text)


def _normalize_core(text: str) -> str:
    text = _strip_urls(text)
    text = _replace_code_lines(text)
    text = _replace_long_codes(text)
    text = _strip_masks(text)
    text = _strip_emoji(text)
    text = _strip_markdown(text)

    # Moeda: R$ 1.234,56 -> "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
    def money(m: re.Match[str]) -> str:
        return _money(m.group(1).replace(".", ""), m.group(2))

    text = _apply(text, _MONEY, money)
    text = text.replace("R$", " reais ")

    # Valor com centavos sem o prefixo R$ ("1.500,00" -> "mil e quinhentos reais")
    text = _apply(
        text, _MONEY_BARE, lambda m: _money(m.group(1).replace(".", ""), m.group(2))
    )

    # Documentos formatados -> dígito a dígito com vírgulas nos grupos
    text = _apply(text, _CPF_FMT, lambda m: _spell_grouped(m.group(0), [3, 3, 3, 2]))
    text = _apply(text, _CNPJ_FMT, lambda m: _spell_grouped(m.group(0), [2, 3, 3, 4, 2]))

    # Datas e horas
    text = _apply(text, _DATE, lambda m: _date(m.group(1), m.group(2), m.group(3)))

    # Telefone com hífen (98765-4321) — dígito a dígito
    text = _apply(
        text,
        _PHONE_HYPHEN,
        lambda m: _spell_digits(m.group(1)) + ", " + _spell_digits(m.group(2)),
    )
    text = _apply(text, _TIME, lambda m: _time(m.group(1), m.group(2)))
    text = _apply(text, _H_TIME, lambda m: _time(m.group(1), m.group(2)))

    # Porcentagem e multiplicação
    def percent(m: re.Match[str]) -> str:
        raw = m.group(1)
        if "," in raw:
            whole, frac = raw.split(",", 1)
            return f"{_cardinal(int(whole))} vírgula {_frac_words(frac)} por cento"
        return f"{_cardinal(int(raw))} por cento"

    text = _apply(text, _PERCENT, percent)
    text = _apply(text, _TIMES_X, lambda m: f"{_cardinal(int(m.group(1)))} vezes")

    # Milhares com ponto (1.500 -> mil e quinhentos)
    text = _apply(text, _THOUSANDS, lambda m: _cardinal(int(m.group(0).replace(".", ""))))

    # Decimais soltos (1,5 -> um vírgula cinco)
    def decimal(m: re.Match[str]) -> str:
        return f"{_cardinal(int(m.group(1)))} vírgula {_frac_words(m.group(2))}"

    text = _apply(text, _DECIMAL, decimal)

    # Inteiros restantes
    text = _apply(text, _INT, lambda m: _cardinal(int(m.group(0))))

    # Léxico (PIX, WhatsApp, nº)
    for pattern, repl in _LEXICON:
        text = pattern.sub(repl, text)

    # Limpeza final
    text = re.sub(r"[(){}\[\]]", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" +([,.;:!?])", r"\1", text)
    text = re.sub(r"([,.;:!?])\1+", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_pt_br(text: str) -> str:
    """Normaliza texto pt-BR para fala natural. Nunca lança exceção."""
    if not text or not text.strip():
        return ""
    try:
        return _normalize_core(text)
    except Exception:  # noqa: BLE001 — TTS nunca pode quebrar por normalização
        return text.strip()
