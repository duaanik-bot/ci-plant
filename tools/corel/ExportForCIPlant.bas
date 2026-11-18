Attribute VB_Name = "ExportForCIPlant"
' Export for CI Plant — the designer's button in CorelDRAW 2024 (Windows).
' Owner, 17 Nov 2026: the approval proof is built from the designer's own CorelDRAW export, sent by a button the
' designer presses. Design: plans/2026-11-17-artwork-workflow-design.md section 5.
'
' Press it with the single-up open. It:
'   1. saves the .cdr,
'   2. exports a PDF into %TEMP%\CIPlant (never over a PDF next to the .cdr) — colours as in the file, fonts embedded,
'   3. reads the page size and the colours used (process inks + named spot colours),
'   4. sends the PDF to CI Plant in pieces of up to 3 MB with this PC's key, and says which job it went to.
' The file name must carry the item code and revision as the house names files ("PCS-B398-R3 - ... CARTON.cdr");
' otherwise CI Plant keeps the export and asks a person which job it is for.
'
' Setup once per PC: run SetUpCIPlantKey and paste the key an admin made in CI Plant (Artwork > Designer PCs).
' Nothing here changes the artwork. It never sends mail; CI Plant only builds a draft that a person reviews.
Option Explicit

Private Const APP As String = "CIPlant"
Private Const SECTION As String = "Artwork"
Private Const DEFAULT_URL As String = "https://motionci.in"

Public Sub SetUpCIPlantKey()
    Dim k As String, u As String
    k = InputBox("Paste this PC's artwork key from CI Plant (Artwork > Designer PCs):", "CI Plant key", GetSetting(APP, SECTION, "Key", ""))
    If Len(Trim$(k)) = 0 Then Exit Sub
    u = InputBox("CI Plant address (leave as it is):", "CI Plant address", GetSetting(APP, SECTION, "Url", DEFAULT_URL))
    If Len(Trim$(u)) = 0 Then u = DEFAULT_URL
    SaveSetting APP, SECTION, "Key", Trim$(k)
    SaveSetting APP, SECTION, "Url", Trim$(u)
    MsgBox "Saved. Now press Export for CI Plant with an artwork open.", vbInformation, "CI Plant"
End Sub

Public Sub ExportForCIPlant()
    Dim doc As Document, key As String, baseUrl As String
    Dim pdfPath As String, cdrName As String
    On Error GoTo Failed

    key = GetSetting(APP, SECTION, "Key", "")
    baseUrl = GetSetting(APP, SECTION, "Url", DEFAULT_URL)
    If Len(key) = 0 Then
        MsgBox "This PC has no CI Plant key yet. Run SetUpCIPlantKey first.", vbExclamation, "CI Plant"
        Exit Sub
    End If
    If Documents.Count = 0 Then
        MsgBox "Open the artwork first.", vbExclamation, "CI Plant"
        Exit Sub
    End If
    Set doc = ActiveDocument
    If Len(doc.FilePath) = 0 Then
        MsgBox "Save the artwork as a .cdr first (with the item code and revision in its name).", vbExclamation, "CI Plant"
        Exit Sub
    End If

    ' 1. save
    doc.Save
    cdrName = doc.FileName
    ' export into a CI Plant folder under TEMP: never overwrite the PDF that sits next to the .cdr (often the client's)
    Dim tmp As String
    tmp = Environ$("TEMP") & "\CIPlant\"
    If Len(Dir$(tmp, vbDirectory)) = 0 Then MkDir tmp
    pdfPath = tmp & Left$(cdrName, InStrRev(cdrName, ".") - 1) & ".pdf"

    ' 2. export the PDF: whole document, colours as in the file, fonts embedded
    With doc.PDFSettings
        .PublishRange = pdfWholeDocument
        .ColorMode = pdfNative
        .ConvertSpotColors = False
        .EmbedFonts = True
        .EmbedBaseFonts = True
        .Overprints = True
    End With
    doc.PublishToPDF pdfPath

    ' 3. size and colours
    Dim w As Double, h As Double, colours As String
    Dim oldUnit As Long
    oldUnit = doc.Unit
    doc.Unit = cdrMillimeter
    w = doc.Pages(1).SizeWidth
    h = doc.Pages(1).SizeHeight
    doc.Unit = oldUnit
    colours = ColoursUsed(doc)

    ' 4. send
    Dim bytes() As Byte, size As Long, sha As String
    bytes = ReadAll(pdfPath)
    size = UBound(bytes) - LBound(bytes) + 1
    sha = FileSha256(pdfPath)

    Dim body As String, answer As String, upload As String, chunkSize As Long, chunks As Long, i As Long
    body = "{""file_name"":" & Js(cdrName) & ",""size_bytes"":" & size & ",""sha256"":" & Js(sha) & _
           ",""page_w_mm"":" & Num(w) & ",""page_h_mm"":" & Num(h) & ",""colours"":[" & colours & "]}"
    answer = Http("POST", baseUrl & "/api/artwork/export/start", key, "application/json", body)
    upload = JsonText(answer, "upload")
    chunkSize = CLng(JsonNumber(answer, "chunk_size"))
    chunks = CLng(JsonNumber(answer, "chunks"))
    If Len(upload) = 0 Or chunkSize <= 0 Then Err.Raise vbObjectError + 1, , "CI Plant did not start the upload: " & answer

    For i = 0 To chunks - 1
        Dim n As Long, piece() As Byte, j As Long
        n = chunkSize
        If (i + 1) * chunkSize > size Then n = size - i * chunkSize
        ReDim piece(0 To n - 1)
        For j = 0 To n - 1
            piece(j) = bytes(LBound(bytes) + i * chunkSize + j)
        Next j
        Http "PUT", baseUrl & "/api/artwork/export/" & upload & "/chunk/" & i, key, "application/octet-stream", piece
    Next i

    answer = Http("POST", baseUrl & "/api/artwork/export/" & upload & "/finish", key, "application/json", "{}")
    If InStr(answer, """matched"":true") > 0 Then
        MsgBox "Sent to CI Plant. The job is ready for Send for approval." & vbCrLf & vbCrLf & cdrName, vbInformation, "CI Plant"
    Else
        MsgBox "Sent to CI Plant, but it could not tell which job this is:" & vbCrLf & JsonText(answer, "why") & vbCrLf & vbCrLf & _
               "Open the job in CI Plant and use Upload designer's PDF, or rename the file with the item code and revision.", vbExclamation, "CI Plant"
    End If
    Exit Sub

Failed:
    MsgBox "Export for CI Plant failed:" & vbCrLf & Err.Description & vbCrLf & vbCrLf & "Nothing was changed in the artwork.", vbCritical, "CI Plant"
End Sub

' Process inks and named spot colours used anywhere in the document, inside groups and PowerClips too.
Private Function ColoursUsed(doc As Document) As String
    Dim seen As Object, p As Page, s As Shape
    Set seen = CreateObject("Scripting.Dictionary")
    For Each p In doc.Pages
        For Each s In p.Shapes.FindShapes()
            Collect s, seen
        Next s
    Next p
    Dim k As Variant, out As String
    For Each k In seen.Keys
        If Len(out) > 0 Then out = out & ","
        out = out & Js(CStr(k))
    Next k
    ColoursUsed = out
End Function

Private Sub Collect(s As Shape, seen As Object)
    On Error Resume Next
    If s.Fill.Type = cdrUniformFill Then AddColour s.Fill.UniformColor, seen
    If s.Outline.Type <> cdrNoOutline Then AddColour s.Outline.Color, seen
    Dim inner As Shape
    If Not s.PowerClip Is Nothing Then
        For Each inner In s.PowerClip.Shapes.FindShapes()
            Collect inner, seen
        Next inner
    End If
End Sub

Private Sub AddColour(c As Color, seen As Object)
    On Error Resume Next
    If c.IsSpot Then
        If Not seen.Exists(c.Name) Then seen.Add c.Name, True
        Exit Sub
    End If
    ' read a COPY: converting the shape's own colour would recolour the artwork
    Dim t As Color
    Set t = CreateColor()
    t.CopyAssign c
    t.ConvertToCMYK
    If t.CMYKCyan > 0 And Not seen.Exists("Cyan") Then seen.Add "Cyan", True
    If t.CMYKMagenta > 0 And Not seen.Exists("Magenta") Then seen.Add "Magenta", True
    If t.CMYKYellow > 0 And Not seen.Exists("Yellow") Then seen.Add "Yellow", True
    If t.CMYKBlack > 0 And Not seen.Exists("Black") Then seen.Add "Black", True
End Sub

Private Function ReadAll(path As String) As Byte()
    Dim st As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1
    st.Open
    st.LoadFromFile path
    ReadAll = st.Read
    st.Close
End Function

' The file's sha256, by Windows' own PowerShell (Get-FileHash).
Private Function FileSha256(path As String) As String
    Dim sh As Object, ex As Object, out As String
    Set sh = CreateObject("WScript.Shell")
    Set ex = sh.Exec("powershell -NoProfile -NonInteractive -Command ""(Get-FileHash -Algorithm SHA256 -LiteralPath '" & Replace(path, "'", "''") & "').Hash""")
    out = ex.StdOut.ReadAll
    FileSha256 = LCase$(Trim$(Replace(Replace(out, vbCr, ""), vbLf, "")))
    If Len(FileSha256) <> 64 Then Err.Raise vbObjectError + 2, , "Could not take the file's fingerprint (PowerShell Get-FileHash)."
End Function

Private Function Http(method As String, url As String, key As String, ctype As String, body As Variant) As String
    Dim x As Object
    Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    x.setTimeouts 10000, 10000, 120000, 120000
    x.Open method, url, False
    x.setRequestHeader "x-artwork-key", key
    x.setRequestHeader "content-type", ctype
    x.send body
    If x.Status < 200 Or x.Status >= 300 Then
        Err.Raise vbObjectError + 3, , "CI Plant answered " & x.Status & ": " & JsonText(x.responseText, "error")
    End If
    Http = x.responseText
End Function

' Tiny JSON helpers: CI Plant's answers are flat.
Private Function JsonText(json As String, name As String) As String
    Dim p As Long, q As Long
    p = InStr(json, """" & name & """:""")
    If p = 0 Then Exit Function
    p = p + Len(name) + 4
    q = InStr(p, json, """")
    If q > p Then JsonText = Mid$(json, p, q - p)
End Function

Private Function JsonNumber(json As String, name As String) As Double
    Dim p As Long, q As Long
    p = InStr(json, """" & name & """:")
    If p = 0 Then Exit Function
    p = p + Len(name) + 3
    q = p
    Do While q <= Len(json) And InStr("0123456789.", Mid$(json, q, 1)) > 0
        q = q + 1
    Loop
    JsonNumber = Val(Mid$(json, p, q - p))
End Function

Private Function Js(s As String) As String
    Js = """" & Replace(Replace(Replace(s, "\", "\\"), """", "\"""), vbTab, " ") & """"
End Function

Private Function Num(d As Double) As String
    Num = Replace(Format$(d, "0.0"), ",", ".")
End Function
