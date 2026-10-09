#!/usr/bin/env node
/**
 * Breaking-changes fixer (template).
 *
 * Copy this file to the repo root as `scripts/fix-breaking-changes.js`, then customize ONLY the
 * `applyFixes` function below based on the patterns documented in `breaking-changes.md`.
 * Run with `node scripts/fix-breaking-changes.js`, verify with theme check, then delete the copy.
 *
 * It walks every JSON file under `templates/` — including subfolders like `templates/customers/`
 * and `templates/metaobject/` — plus `config/settings_data.json`, applies `applyFixes` recursively,
 * and writes the result back, preserving template comment headers and 2-space JSON. Exits non-zero
 * if any file failed, so a broken JSON can't hide behind the final banner.
 */
const fs = require('fs')
const path = require('path')

const templatesDir = './templates'
const configFile = './config/settings_data.json'

let errorCount = 0

// ========================================
// CUSTOMIZE THIS SECTION BASED ON breaking-changes.md
// Literal key/value rewrites only — no require(), no process spawn, no network, no writes
// outside templates/**/*.json and config/settings_data.json.
// ========================================
const applyFixes = (obj) => {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(applyFixes)

  const result = { ...obj }

  // ADD YOUR BREAKING-CHANGE FIXES HERE. Common patterns:
  //
  // 1. Remove specific settings:
  //    if (result.settings?.product === '{{ closest.product }}') delete result.settings.product
  //    delete result.settings?.deprecated_setting
  //
  // 2. Update block types:
  //    if (result.type === 'old-block-type') result.type = 'new-block-type'
  //
  // 3. Update setting values:
  //    if (result.settings?.some_property === 'old-value') result.settings.some_property = 'new-value'
  //
  // 4. Rename properties:
  //    if (result.old_property_name) {
  //      result.new_property_name = result.old_property_name
  //      delete result.old_property_name
  //    }

  // Recurse into nested objects.
  for (const key in result) {
    if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = applyFixes(result[key])
    }
  }
  return result
}
// ========================================
// END CUSTOMIZATION SECTION
// ========================================

const processTemplateFile = (filePath) => {
  try {
    console.log(`Processing ${filePath}...`)
    const content = fs.readFileSync(filePath, 'utf8')

    // Preserve a leading /* ... */ comment header if present.
    const commentMatch = content.match(/^(\/\*[\s\S]*?\*\/)\s*/)
    const comment = commentMatch ? commentMatch[1] : ''
    const jsonContent = commentMatch ? content.slice(commentMatch[0].length) : content

    const processed = applyFixes(JSON.parse(jsonContent))
    const json = JSON.stringify(processed, null, 2)
    fs.writeFileSync(filePath, (comment ? `${comment}\n${json}` : json) + '\n')
    console.log(`✓ Updated ${filePath}`)
  } catch (error) {
    errorCount++
    console.error(`Error processing ${filePath}:`, error.message)
  }
}

// a theme-pulled settings_data.json opens with Shopify's /* … */ banner too —
// same strip/re-prepend handling as templates
const processConfigFile = (filePath) => processTemplateFile(filePath)

const walkJsonFiles = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJsonFiles(p))
    else if (entry.name.endsWith('.json')) out.push(p)
  }
  return out
}

const main = () => {
  console.log('🔧 Fixing breaking changes in template files and config...\n')

  const jsonFiles = fs.existsSync(templatesDir) ? walkJsonFiles(templatesDir) : []
  if (jsonFiles.length > 0) {
    console.log(`Found ${jsonFiles.length} template files to process:\n`)
    jsonFiles.forEach((f) => processTemplateFile(f))
  } else {
    console.log('No JSON template files found.')
  }

  if (fs.existsSync(configFile)) {
    console.log(`\nProcessing config file: ${configFile}`)
    processConfigFile(configFile)
  } else {
    console.log(`\nConfig file not found: ${configFile}`)
  }

  if (errorCount > 0) {
    console.error(`\n⚠️  Finished with ${errorCount} error(s) — the file(s) that failed above were NOT updated.`)
    process.exitCode = 1
  } else {
    console.log('\n✅ All template files and config have been processed!')
  }
  console.log('Next: run theme check to verify fixes')
}

if (require.main === module) main()
