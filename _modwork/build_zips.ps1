Add-Type -AssemblyName "System.IO.Compression"
Add-Type -AssemblyName "System.IO.Compression.FileSystem"

$modDir = $PSScriptRoot
$mods = @("FS25_Poslovi", "FS25_KupnjNaRate", "FS25_SlavonskaRavnica_Manager")

foreach ($mod in $mods) {
    $src = Join-Path $modDir $mod
    $zipPath = Join-Path $modDir "$mod.zip"
    
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    
    $zip = [IO.Compression.ZipFile]::Open($zipPath, "Create")
    
    Get-ChildItem $src -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, "Optimal")
    }
    
    $zip.Dispose()
    $size = (Get-Item $zipPath).Length
    Write-Host "$mod.zip rebuilt - $size bytes"
}

# Verify forward slashes
Write-Host "`n--- Verifying path separators ---"
foreach ($mod in $mods) {
    $zipPath = Join-Path $modDir "$mod.zip"
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    $luaFiles = $zip.Entries | Where-Object { $_.Name -like '*.lua' }
    Write-Host "`n$mod ($($luaFiles.Count) lua files):"
    $luaFiles | ForEach-Object { Write-Host "  $($_.FullName)" }
    $zip.Dispose()
}
