# Windows IFileOperation recycle bridge. Success requires PostDeleteItem to
# return a non-null Recycle Bin item. No permanent-delete fallback is exposed.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    $json = [Console]::In.ReadToEnd()
    [string[]]$paths = @(ConvertFrom-Json $json)
    if ($paths.Count -eq 0) {
        [Console]::Out.Write('[]')
        exit 0
    }

    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'RecycleBin.Native.cs')
    $results = [FixStorage.NativeRecycle]::Recycle($paths)
    [Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 @($results)))
} catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
