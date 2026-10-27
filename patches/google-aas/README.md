# Google Android AAS patch untuk opencode

Menambahkan login AAS Android untuk provider `google` di opencode, sehingga
token OAuth (`ya29...`) bisa dipakai tanpa Gemini API key. Diuji live dengan
master token AAS asli (exchange -> `ya29...` -> generateContent HTTP 200).

## Masalah yang diperbaiki

Gemini Developer API hanya menerima OAuth access token lewat
`Authorization: Bearer`. Path default resolver memasukkan token OAuth ke
package `google` sebagai `apiKey`, yang package itu kirim sebagai header
`x-goog-api-key`; API menolak di sana dengan `API_KEY_INVALID`.

opencode upstream hanya punya satu jalur credential per provider
(`nativeCredentialSettings` di `packages/core/src/model-resolver.ts`), jadi
credential AAS yang di-tukar plugin tidak punya cara untuk memilih jalur
bearer.

## Yang ditambahkan

| File | Perubahan |
|---|---|
| `packages/core/src/plugin/provider/google.ts` | baru. Plugin `GooglePlugin`: method OAuth `aas`, tukar master token AAS (`aas_et/...` atau `androidId=...&Email=...&Token=...`) ke access token, renewal dari master token tersimpan. Flag metadata `aas:true` pada credential |
| `packages/core/src/plugin/provider.ts` | registrasi `GooglePlugin` di array `ProviderPlugins` |
| `packages/core/src/model-resolver.ts` | cabang di `nativeCredentialSettings`: credential OAuth google dengan metadata `aas:true` dikirim sebagai `{ auth: Auth.bearer(credential.access) }` |
| `packages/ai/src/providers/google.ts` | `Settings.auth` + threading `auth` dari settings ke `configure()` (union `ProviderAuthOption` dipakang kondisional), bearer path bila ada `Authorization` header |
| `packages/ai/src/providers/google/interactions.ts` | threading `auth` yang sama |
| `packages/core/test/plugin/provider-google-aas.test.ts` | baru. 7 test bun: registrasi method, exchange, identitas Play services, renewal, email wajib, jalur bearer, jalur apiKey |

## Cara kerja

`/login` -> provider `google` -> method "GA (Android AAS)": tempel `aas_et/...`
atau string lengkap `androidId=...&Email=...&Token=...`. Plugin menukarnya ke
access token lewat `https://android.googleapis.com/auth` dengan scope:

```
oauth2:https://www.googleapis.com/auth/assistant
https://www.googleapis.com/auth/generative-language
https://www.googleapis.com/auth/photos.image.readonly
https://www.googleapis.com/auth/drive
```

Master token disimpan sebagai `refresh` credential dan `refresh()` menukar
ulang, jadi paste sekali tetap jalan melewati masa berlaku access token
(±55 menit).

Identity AAS: app `com.google.android.googlequicksearchbox`, client sig
`38918a453d07199354f8b19af05ec6562ced5788`, UA `GoogleAuth/1.4`.

## Pakai ulang setelah pull upstream sst/opencode

```sh
./apply.sh            # apply (no-op kalau sudah terpasang)
./apply.sh --check    # hanya cek, tidak mengubah apa pun
./apply.sh --verify   # apply lalu jalankan test-nya
```

Repo default: repo git di atas dir patch ini; override dengan
`OC_REPO=/path/to/opencode`. Verifikasi yang sudah dijalankan: beres
checkout upstream/dev 5f8ee0f507 -> apply langsung, idempoten.

Dir ini ada dua salinan: `patches/google-aas/` di checkout fork (payload CI —
dipakai `.github/workflows/patch.yml` untuk verifikasi tiap push, termasuk
merge ke snapshot terbaru `sst/opencode` dev), dan dir standalone di
`~/Downloads/opencode-patches/google-aas/` untuk pemakaian lokal. Perbarui
keduanya sekaligus kalau patch diubah.

Hasil terpasang:

```sh
bun install --ignore-scripts   # hanya kalau node_modules sudah basi
bun run check
cd packages/core && bun test test/plugin/provider-google-aas.test.ts
```

## Perilaku `apply.sh`

- **Idempoten.** Run kedua dan seterusnya no-op.
- **All-or-nothing.** `apply --3way` berjalan di `git worktree` scratch dan
  hanya menyentuh muat asli setelah semua file berhasil.
- **Tidak menimpa perubahan lokal** di file yang di-patch.
- **Jalur cepat.** `git apply` biasa dulu; three-way hanya jika context
  sudah digeser upstream.

## Catatan

Endpoint AAS Android itu internal Google, bukan OAuth resmi; bebas diubah
Google kapan saja. Untuk yang stabil pakai Gemini API key
(`GOOGLE_GENERATIVE_AI_API_KEY`) atau provider `google-vertex` via ADC.
