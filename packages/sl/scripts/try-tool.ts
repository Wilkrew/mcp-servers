#!/usr/bin/env -S node --experimental-strip-types
// Calls one tool against live SL, to check it on real responses:
//   npm run try -- plan_trip from=Odenplan to=Slussen
//   npm run try -- stop_layout stop=Odenplan --save
// key=value passes a string; key:=value passes JSON (trips:=2, avoid:='["BUS"]').
// --save writes each raw SL response to test/fixtures/live/ (git-ignored), ready
// to trim into a recorded fixture.

import { mkdirSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SlApi } from '../src/api.ts'
import { createServer } from '../src/server.ts'

const argv = process.argv.slice(2)
const save = argv.includes('--save')
const [tool, ...pairs] = argv.filter(a => a !== '--save')
if (!tool) {
  console.error('Usage: npm run try -- TOOL key=value key:=json … [--save]')
  process.exit(1)
}

const args: Record<string, unknown> = {}
for (const pair of pairs) {
  const json = /^([\w]+):=(.*)$/s.exec(pair)
  const text = /^([\w]+)=(.*)$/s.exec(pair)
  if (json) args[json[1]] = JSON.parse(json[2])
  else if (text) args[text[1]] = text[2]
  else throw new Error(`Expected key=value or key:=json, got "${pair}"`)
}

const recorded = new Map<string, string>()
const recording = (async (input: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(input, init)
  recorded.set(new URL(String(input)).pathname, await res.clone().text())
  return res
}) as typeof fetch

const [a, b] = InMemoryTransport.createLinkedPair()
await createServer(new SlApi({ fetch: recording })).connect(a)
const client = new Client({ name: 'try-tool', version: '0' })
await client.connect(b)

const res = await client.callTool({ name: tool, arguments: args })
console.log((res.content as { text: string }[])[0].text)

if (save) {
  const dir = new URL('../test/fixtures/live/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  for (const [path, body] of recorded) {
    const file = `${path.replace(/^\/+/, '').replace(/[^\w]+/g, '-')}.json`
    writeFileSync(new URL(file, dir), body)
    console.error(`Saved ${path} to test/fixtures/live/${file}`)
  }
}
await client.close()
