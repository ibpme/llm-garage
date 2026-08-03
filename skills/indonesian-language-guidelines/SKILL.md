---
name: indonesian-language-guidelines
description: Use when producing, translating, editing, or reviewing Indonesian (Bahasa Indonesia) text — emails, messages, documents, UI copy, or customer replies. Apply before finalizing any Indonesian output to catch numeral punctuation, Anda capitalization, kami/kita choice, meN- prefixes, register, dates/currency, and translationese.
license: Proprietary
metadata:
  source: Unbabel language guidelines
---

# Indonesian Language Guidelines

Apply these rules whenever the final output to the user is Indonesian text, regardless of the language the request was written in.

## When to use

Use this skill when you are asked to:

- Write Indonesian text from scratch (email, message, document, UI copy).
- Translate text into Indonesian.
- Edit, proofread, or review existing Indonesian text.
- Localize names, dates, times, numbers, or currency into Indonesian.

## Workflow

1. Draft the Indonesian output naturally.
2. Run the **Gotchas** checklist below — these are the highest-frequency formal errors.
3. Run the **Naturalness check** as a separate pass — it catches translationese and fluency issues that pass every rule.
4. If a specific question is not covered by the lists, load the relevant reference file:
   - Grammar questions → `references/grammar.md`
   - Spelling, capitalization, numerals, compounds → `references/orthography.md`
   - Punctuation → `references/punctuation.md`
   - Formal/informal register → `references/register.md`
   - Names, dates, times, measures, currency, acronyms → `references/localization.md`
   - Common English→Indonesian translation mistakes → `references/frequent-errors.md`
5. Apply corrections directly in the output. Do not narrate which rule was applied or flag the correction to the user.
6. If the user or a glossary/style guide they provided explicitly overrides a rule, follow the user's instruction.

## Gotchas

These are the highest-frequency rules that defy English defaults. For full details and worked examples, load the reference file listed above.

**Numerals**

- Thousands separator is a period; decimal separator is a comma: `100.000`, `50,5 kg`.
- Don't add a thousands separator when the number isn't a quantity (e.g., page numbers: `halaman 1305`).
- `billion` → _miliar_, `trillion` → _biliun_.

**Pronouns**

- _kami_ = we (excluding listener); _kita_ = we (including listener). Pick deliberately.
- _Anda_ (formal "you") is always capitalized, even mid-sentence.
- Don't mix formal and informal registers within one text.

**Prepositions**

- _di, ke, dari_ are written as separate words from what follows: `di dalam`, not `didalam`.
- Formal register: use _kepada_/_pada_ before a person, not _ke_.

**Verb prefixes (_meN-_)**

- The prefix's form depends on the first letter of the root: _konfirmasi_ → _mengonfirmasi_, not _mengkonfirmasi_. Check `references/grammar.md` for the full nasalization table.

**Capitalization**

- Capitalize _Anda, Beliau, Tuhan, Allah, -Nya_, titles used as direct address (_Kiai, Bapak_), and every content word in institution/document/book titles (skip prepositions like _di, ke, dari, dan, yang, untuk_).
- Don't capitalize type names (_ikan lele_) or unit names (_2 ampere_).

**Dates, time, currency, measures**

- Dates: `dd-mm-yyyy` or `dd MMMM yyyy`.
- Formal time: 24-hour (`pukul 18.00`); informal can use `pukul 6 sore`.
- Currency symbol precedes the value with no period or space: `Rp100.000`, not `Rp. 100.000`. Currency codes precede the symbol with no space or period: `USD$60`.
- Keep unit abbreviations as-is: `kg`, `cm`, `ft` — no trailing period.

**Proper nouns & localization**

- Personal names stay untranslated.
- Places: use the conventional Indonesian form when one exists (_Belanda_, not _the Netherlands_).
- Organizations: try the Indonesian translation first (_Perserikatan Bangsa-Bangsa_); if obscure, give translated form + original in brackets.
- Brands and product names stay untranslated and italicized.

**Punctuation**

- Greetings and closings are followed by a comma; the following line starts with a capital letter.
- `%`, `/`, `|` are written with no preceding space: `97%`.

## Naturalness check

Translationese is a different failure mode from the checklist above. Even when every rule is correct, the text can still sound translated. After the rule check, do a separate pass and ask:

_"Baca ulang seolah-olah kamu penutur asli — apakah ada kalimat yang terasa kaku, terlalu formal, atau seperti terjemahan? Perbaiki agar terdengar alami."_

Watch for these patterns:

- Filler subjects (_hal ini_, _hal tersebut_) where a native writer would drop the subject or restructure the sentence.
- Copula _adalah_ inserted unnecessarily: _Dia adalah guru_ → _Dia guru_.
- _Yang mana_ / _di mana_ as literal English relatives.
- Long noun phrases stacked with multiple _yang_ clauses; prefer shorter native sentences.
- Sentences opening with _Dalam..._ / _Untuk..._ mimicking English "In..." / "To..." openers.
- Literal idioms: _membuat sense_ → _masuk akal_, _pada akhir hari_ → avoid, _mengambil tempat_ → _terjadi_ / _berlangsung_.
- Loanwords when everyday words fit: _implementasi_ → _penerapan_, _signifikan_ → _penting_ / _besar_.
- Excessive passive voice (_di-_ prefix) where active voice (_me-_ prefix) would be more direct.
- Redundant plural reduplication when a quantifier or context already marks plurality.
- Missing discourse particles (_lah, kan, kok, sih, dong_) in informal register, or forced particles in formal register.
- Overuse of explicit connectors (_oleh karena itu, selain itu, dengan demikian_) — natural Indonesian often implies transitions.
- Flat, generic phrasing where an idiomatic expression would fit.
- Wrong politeness level for the audience: _Anda_ vs _kamu_/_lo-gue_ vs _Bapak/Ibu_.
