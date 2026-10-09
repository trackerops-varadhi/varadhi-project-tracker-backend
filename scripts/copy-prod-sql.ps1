# ---------------------------------------------------------------------------
# copy-prod-sql.ps1 -- put one production SQL step on the clipboard, ready to
# paste into the Supabase SQL editor.
#
#   .\scripts\copy-prod-sql.ps1            list the steps
#   .\scripts\copy-prod-sql.ps1 precheck   copy that step
#
# Read-only: it never connects to any database. It copies text, nothing else.
# The cutover file is split because its three parts must be run separately --
# PART 0's output is the rollback script and is only valid before PART 1.
# ---------------------------------------------------------------------------
param([string]$Step)

$docs = Join-Path $PSScriptRoot '..\docs'

# name -> file, and for the cutover, the 1-based line range of that part
$steps = [ordered]@{
  'precheck'  = @{ file = 'production-precheck.sql';              note = 'read-only. Which scripts has this database already had?' }
  'drift'     = @{ file = 'drift-check.sql';                      note = 'read-only. Stop on any stop condition.' }
  'state'     = @{ file = 'production-state.sql';                 note = 'read-only. Every ledger row with its timestamp - run this when a guard refuses.' }
  'inventory' = @{ file = 'production-module9-inventory.sql';     note = 'read-only. What people and workforce actually contain, column by column.' }
  'cutover0'  = @{ file = 'production-cutover.sql'; from = 36;  to = 105; note = 'read-only. SAVE THE OUTPUT - it is the rollback script.' }
  'cutover1'  = @{ file = 'production-cutover.sql'; from = 107; to = 283; note = 'THE CUTOVER. Backup first. One transaction.' }
  'cutover2'  = @{ file = 'production-cutover.sql'; from = 285; to = 326; note = 'read-only verify.' }
  'defects'   = @{ file = 'production-defects-create.sql';        note = 'creates the 5 bug tables.' }
  'ledger'    = @{ file = 'production-ledger-and-migrations.sql'; note = 'ledgers + identity/work 0002. AFTER defects.' }
  'people'    = @{ file = 'production-people-create.sql';         note = 'creates the people schema.' }
  'module9'   = @{ file = 'production-module9-full.sql';          note = 'hr role, profile, recruitment, leave, work status.' }
  'qc'        = @{ file = 'production-qc-role.sql';               note = 'adds the qc role.' }
  'verify'    = @{ file = 'production-verify.sql';                note = 'read-only. Final check: every Module 9 object, and anything left in public.' }
  'shadow'    = @{ file = 'production-public-shadow.sql';         note = 'read-only. What is inside the public.user_sessions / user_tokens shadows.' }
  'dropshadow'= @{ file = 'production-drop-public-shadow.sql';    note = 'DESTRUCTIVE and optional. Drops public.user_sessions / user_tokens. Read its header first.' }
}

if (-not $Step) {
  Write-Host ''
  Write-Host 'Run the steps in this order. Each one stops safely if it has already been applied.'
  Write-Host ''
  $i = 0
  foreach ($k in $steps.Keys) {
    $i++
    Write-Host ("  {0,2}. {1,-10} {2}" -f $i, $k, $steps[$k].note)
  }
  Write-Host ''
  Write-Host 'Usage: .\scripts\copy-prod-sql.ps1 <name>   then Ctrl+V in the Supabase SQL editor.'
  Write-Host ''
  return
}

if (-not $steps.Contains($Step)) {
  Write-Host ("Unknown step '{0}'. Run without arguments to see the list." -f $Step)
  exit 1
}

$s = $steps[$Step]
$path = Join-Path $docs $s.file
if (-not (Test-Path $path)) { Write-Host ("Missing file: {0}" -f $path); exit 1 }

if ($s.Contains('from')) {
  $lines = Get-Content $path -Encoding UTF8
  $text = ($lines[($s.from - 1)..($s.to - 1)]) -join "`r`n"
} else {
  $text = Get-Content $path -Raw -Encoding UTF8
}

Set-Clipboard -Value $text
$n = ($text -split "`n").Count
Write-Host ''
Write-Host ("Copied: {0}{1}" -f $s.file, $(if ($s.Contains('from')) { " lines $($s.from)-$($s.to)" } else { '' }))
Write-Host ("        {0} lines, {1} characters" -f $n, $text.Length)
Write-Host ("Note:   {0}" -f $s.note)
Write-Host ''
Write-Host 'Now: Supabase -> SQL Editor -> New query -> Ctrl+V -> Run.'
Write-Host ''
