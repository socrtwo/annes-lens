# Anne's Lens Command Reference

Anne's Lens has **568 commands** built, out of the **569** in the plan ([COMMANDS-PLAN.md](COMMANDS-PLAN.md)). Every built command can be placed on the Quick Access Bar, added to a custom tab, found in the classic menus, bound to a keyboard shortcut, recorded in a macro, or found with command search (Alt+Q). A command is registered only when it works; the rest of the plan is listed at the end of this file.

26 of the built commands are "Commands Not in the Tabs" (reachable through the Quick Access Bar chooser, Customize Tabs, the classic menus and command search), so nothing the app can do is hidden.

This file is generated from the source by `npm run catalog`; a unit test fails when it is out of date.

## Ribbon

The ribbon mirrors the plan: one tab per plan tab and one group per plan group, in the plan's order, plus the Home tab. Groups that have no built command yet are not shown.

- **Home**: Clipboard (4) · Navigate (5) · Rotate (5) · Quick fix (6) · Organize (7) · View (5) · Share (4)
- **File**: Open (16) · Save (9) · Export (9) · Files (11) · Acquire (7) · Print (6) · Share (6) · Close and options (12)
- **Edit**: Undo (3) · Clipboard (9) · Select (10) · Crop (5) · Add (5) · Paint and markup (5) · Find (2)
- **Image**: Information (4) · Scientific pictures (4) · Rotate and flip (12) · Lossless JPEG (3) · Size (6) · Color depth and palette (12) · Color management (3)
- **Adjust**: Automatic (6) · Tone (14) · Color (11) · Detail and retouch (9) · Presets and history (7)
- **Effects**: Browse (3) · Artistic (13) · Photographic (11) · Distort (14) · Frames and shadows (5)
- **Browse**: Views (20) · Rate and label (8) · Find and compare (8) · Catalog (5)
- **Metadata**: View and edit (12) · Date and place (5) · Privacy and integrity (5) · Records and genealogy (4)
- **Batch**: Batch (13)
- **Create**: Create (17)
- **Pages and Frames** (contextual): Pages (7) · Frames (8)
- **RAW** (contextual): RAW (4)
- **View**: Zoom (12) · Navigate (9) · Window (16) · Inspect (12) · Display (11) · Compare (6) · Media (4) · Quick Access Bar and search (5)
- **Slideshow**: Slideshow (13)
- **Tools**: Text and codes (4) · Documents and print (4) · Color and vector (2) · Organize (2) · Extend (2)
- **AI**: Generate (10) · Edit (20) · Select (3) · Understand (12) · Provenance (2) · Providers (9)
- **Developer**: Developer (7)
- **Help**: Help (9)

## Classic menu layouts

| Layout | Modeled on | Built commands on the bar |
|---|---|---|
| IrfanView style (`irfanview`) | IrfanView 4.x main window (File, Edit, Image, Options, View, Help) | 207 |
| IrfanView Thumbnails style (`irfanview-thumbs`) | IrfanView 4.x thumbnail window | 89 |
| XnView style (`xnview`) | XnView MP browser and viewer (File, Edit, View, Image, Metadata, Tools, Create, Help) | 210 |
| FastStone style (`faststone`) | FastStone Image Viewer (File, Edit, Colors, Effects, View, Create, Tools, Settings, Help) | 167 |
| ACDSee style (`acdsee`) | ACDSee Photo Studio (Manage and View modes: File, Edit, View, Panes, Tools, Help) | 144 |
| Windows Photo Viewer style (`photoviewer`) | Windows Photo Viewer and Microsoft Photos (toolbar commands as menus) | 97 |
| Picasa style (`picasa`) | Picasa 3 (File, Edit, View, Folder, Picture, Create, Tools, Help) | 140 |
| Preview style (`preview`) | macOS Preview (File, Edit, View, Go, Tools, Window, Help) | 124 |
| digiKam style (`digikam`) | digiKam 8 main window (Browse, Album, Tag, Item, Edit, View, Tools, Import, Export, Settings, Help) | 147 |
| All viewers combined (`all`) | the union of every layout above, merged menu by menu without duplicates (Picture, Modify and Item merge into Image; Go and Window into View; Album, Tag and Folder into Organize; Import and Export into File; Settings into Options) | 377 |
| Anne's Lens complete (`complete`) | the ribbon itself: one menu per tab, one submenu per group, every command | 568 |

## File (82 of 82)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Clear Recent Lists | Open |  | `file.clearRecent` | not in tabs |
| Open and Repair… | Open |  | `file.openRepair` | from the Anne's Office suite |
| Open as Hex | Open |  | `file.openHex` | from IrfanView, XnView Classic and XnView MP |
| Open as Text | Open |  | `file.openText` | from IrfanView |
| Open Encrypted Picture… | Open |  | `file.openEncrypted` | from the Anne's Office suite |
| Open Folder… | Open | Ctrl+Shift+o | `file.openFolder` | from XnView Classic and XnView MP, FastStone Image Viewer, digiKam |
| Open in New Window | Open | Ctrl+n | `file.newWindow` | from nomacs, Preview, IrfanView |
| Open RAW Pixel Data… | Open |  | `file.openRawPixels` | from IrfanView |
| Open URL… | Open |  | `file.openUrl` | from IrfanView, XnView Classic and XnView MP |
| Open With (system) | Open |  | `file.openWith` | from Microsoft Photos, Preview, Android gallery apps |
| Open with External Editor | Open | Shift+e | `file.openExternal` | has options menu; from IrfanView, XnView Classic and XnView MP |
| Open… | Open | o, Ctrl+o | `file.open` | from IrfanView, most picture viewers |
| Recent Files | Open |  | `file.openRecent` | has options menu; from IrfanView, XnView Classic and XnView MP |
| Recent Folders | Open |  | `file.recentFolders` | has options menu; from XnView Classic and XnView MP, FastStone Image Viewer |
| Recover Pictures from Any File… | Open |  | `file.recoverAny` | from the Anne's Office suite, new in Anne's Lens |
| Recovery Report | Open |  | `file.recoveryReport` | from the Anne's Office suite |
| Show in Folder | Open | Ctrl+Shift+e | `file.revealInFolder` | from IrfanView, XnView Classic and XnView MP, Microsoft Photos |
| Encrypt Picture… | Save |  | `file.encrypt` | from the Anne's Office suite, new in Anne's Lens |
| Reload | Save | Shift+r | `file.reload` | from IrfanView |
| Save | Save | Ctrl+s | `file.save` | from IrfanView, most picture viewers |
| Save a Copy… | Save |  | `file.saveCopy` |  |
| Save All Changed | Save | Ctrl+Shift+s | `file.saveAll` | from new in Anne's Lens |
| Save As… | Save | s | `file.saveAs` | from IrfanView |
| Save for Web… | Save | Ctrl+Alt+s | `file.saveForWeb` | from IrfanView, XnView Classic and XnView MP |
| Save Selection As… | Save |  | `file.saveSelection` | from IrfanView |
| Save to Target File Size… | Save |  | `file.saveTargetSize` | from IrfanView, new in Anne's Lens |
| Export Animation (GIF, WebP, APNG)… | Export |  | `file.export.animation` | from XnView Classic and XnView MP, new in Anne's Lens |
| Export as Icon (.ico, .icns)… | Export |  | `file.export.icon` | from Graphic Workshop, IrfanView |
| Export as PDF… | Export |  | `file.export.pdf` | from IrfanView, Preview |
| Export Metadata as CSV… | Export |  | `file.export.metadataCsv` | from XnView Classic and XnView MP, digiKam |
| Export Palette… | Export |  | `file.export.palette` | from IrfanView |
| Insert into Anne's Pen | Export |  | `file.export.pen` | from the Anne's Office suite |
| Send to Anne's Folio | Export |  | `file.export.folio` | from the Anne's Office suite |
| Send to Anne's Press | Export |  | `file.export.press` | from the Anne's Office suite |
| Send to Anne's Stage | Export |  | `file.export.stage` | from the Anne's Office suite |
| Change File Date/Time… | Files |  | `file.setFileTime` | from FastStone Image Viewer, XnView Classic and XnView MP |
| Copy as File (for pasting in file managers) | Files |  | `file.copyAsFile` | not in tabs; from XnView Classic and XnView MP |
| Copy File Name | Files |  | `file.copyName` | not in tabs; from IrfanView |
| Copy Full Path | Files |  | `file.copyPath` | not in tabs; from XnView Classic and XnView MP |
| Copy To… | Files | F8 | `file.copyTo` | from IrfanView |
| Delete | Files | Delete | `file.delete` | from IrfanView, most picture viewers |
| Delete Permanently | Files | Shift+Delete | `file.deletePermanent` | from IrfanView, XnView Classic and XnView MP |
| File Date from EXIF Date | Files |  | `file.fileTimeFromExif` | from XnView Classic and XnView MP, IrfanView |
| File Properties (system) | Files | Alt+Enter | `file.sysProperties` | not in tabs; from Windows Photo Viewer and Windows Picture and Fax Viewer, XnView Classic and XnView MP |
| Hide Picture | Files |  | `file.hide` | has options menu; from Picasa, Apple Photos and iPhoto, Google Photos |
| Move To… | Files | F7 | `file.moveTo` | from IrfanView |
| Quick Copy to Folder 1–9 | Files |  | `file.quickCopy` | has options menu; from FastStone Image Viewer, XnView Classic and XnView MP, FastPictureViewer |
| Quick Move to Folder 1–9 | Files |  | `file.quickMove` | has options menu; from FastStone Image Viewer, XnView Classic and XnView MP, FastPictureViewer |
| Rename… | Files | F2 | `file.rename` | from IrfanView, most picture viewers |
| Undo File Operation | Files | Ctrl+Alt+z | `file.undoFileOp` | from new in Anne's Lens |
| Batch Scanning… | Acquire |  | `file.batchScan` | from IrfanView |
| Camera Capture | Acquire |  | `file.captureCamera` | from new in Anne's Lens |
| Import from Camera or Phone… | Acquire |  | `file.importCamera` | from Picasa, gThumb, digiKam, Preview, Microsoft Photos, Apple Photos and iPhoto |
| Import with Rules… | Acquire |  | `file.importRules` | has options menu; from digiKam, Lightroom Classic (Library and Develop) |
| Scan… | Acquire | Ctrl+Shift+a | `file.scan` | from IrfanView, Preview, Kodak/Wang Imaging for Windows |
| Screen Capture… | Acquire | c | `file.capture` | from IrfanView, Preview, FastStone Image Viewer |
| Select Scan Source… | Acquire |  | `file.selectSource` | from IrfanView |
| Print at True Size… | Print |  | `file.printTrueSize` | from new in Anne's Lens |
| Print Copies and Posters… | Print |  | `file.copyShop` | from IrfanView |
| Print Layouts (several per page)… | Print |  | `file.printLayouts` | from Windows Photo Viewer and Windows Picture and Fax Viewer, Microsoft Photos, Picasa, FastStone Image Viewer |
| Print Preview | Print |  | `file.printPreview` | from IrfanView, Microsoft Photos |
| Print Setup… | Print |  | `file.printSetup` | not in tabs; from IrfanView |
| Print… | Print | Ctrl+p | `file.print` | from IrfanView, most picture viewers |
| Quick Print | Print |  | `file.quickPrint` |  |
| Cast to Display | Share |  | `file.cast` | from Google Photos, Android gallery apps |
| Email… | Share | Shift+m | `file.email` | from IrfanView, Windows Photo Viewer and Windows Picture and Fax Viewer, Picasa, FastStone Image Viewer |
| Set as Contact Photo | Share |  | `file.contactPhoto` | from Android gallery apps |
| Set as Lock Screen | Share |  | `file.lockScreen` | from Microsoft Photos, Android gallery apps |
| Set as Wallpaper | Share | Ctrl+Shift+w | `file.wallpaper` | has options menu; from IrfanView, XnView Classic and XnView MP, Windows Photo Viewer and Windows Picture and Fax Viewer |
| Share… | Share |  | `file.share` | from Microsoft Photos, Android gallery apps, Preview |
| Close | Close and options | Ctrl+w | `file.close` |  |
| Close All | Close and options |  | `file.closeAll` |  |
| Customize Keyboard… | Close and options |  | `file.customizeKeyboard` | from the Anne's Office suite, IrfanView |
| Customize Menus… | Close and options |  | `file.customizeMenus` | from new in Anne's Lens |
| Customize Quick Access Bar… | Close and options |  | `file.customizeQat` | from the Anne's Office suite |
| Customize Tabs… | Close and options |  | `file.customizeRibbon` | from the Anne's Office suite |
| Exit | Close and options | Escape, Alt+F4 | `file.exit` | from IrfanView |
| Export / Import Settings… | Close and options |  | `file.exportSettings` | from the Anne's Office suite, IrfanView |
| File Associations… | Close and options |  | `file.associations` | from IrfanView, XnView Classic and XnView MP |
| Options… | Close and options | p | `file.options` | from IrfanView |
| Portable Mode | Close and options |  | `file.portableMode` | from IrfanView, XnView Classic and XnView MP |
| Reset All Customizations | Close and options |  | `file.resetCustomizations` | from the Anne's Office suite |

## Edit (55 of 55)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| History Panel | Undo | Ctrl+Alt+h | `edit.history` | from new in Anne's Lens |
| Redo | Undo | Ctrl+Shift+z | `edit.redo` | from most picture viewers |
| Undo | Undo | Ctrl+z | `edit.undo` | from IrfanView, most picture viewers |
| Clear Selection | Clipboard |  | `edit.clear` | from IrfanView |
| Copy | Clipboard | Ctrl+c | `edit.copy` | from IrfanView, most picture viewers |
| Cut | Clipboard | Ctrl+x | `edit.cut` | from IrfanView |
| Cut Outside Selection | Clipboard | Ctrl+Shift+x | `edit.cutOutside` | from IrfanView |
| Fill Selection… | Clipboard |  | `edit.fill` | from IrfanView, XnView Classic and XnView MP |
| Paste | Clipboard | Ctrl+v | `edit.paste` | from IrfanView, most picture viewers |
| Paste as New Picture | Clipboard | Ctrl+Shift+v | `edit.pasteAsNew` | from IrfanView, XnView Classic and XnView MP |
| Paste Beside | Clipboard |  | `edit.pasteBeside` | has options menu; from IrfanView |
| Paste into Selection | Clipboard |  | `edit.pasteInto` | from IrfanView |
| Custom Selection… | Select | Shift+c | `edit.customSelection` | from IrfanView |
| Ellipse Selection | Select |  | `edit.selectEllipse` | from XnView Classic and XnView MP |
| Invert Selection | Select | Ctrl+Shift+i | `edit.selectInvert` |  |
| Lasso and Polygon Selection | Select |  | `edit.selectLasso` | from XnView Classic and XnView MP |
| Magic Wand | Select |  | `edit.selectWand` | from XnView Classic and XnView MP |
| Maximize Selection to Aspect Ratio | Select |  | `edit.selectMaxAspect` | has options menu; from IrfanView |
| Rectangle Selection | Select |  | `edit.selectRect` | from most picture viewers |
| Select All | Select | Ctrl+a | `edit.selectAll` | from most picture viewers |
| Select by Color Range… | Select |  | `edit.selectColor` | from new in Anne's Lens |
| Select None | Select | Ctrl+d | `edit.selectNone` | from most picture viewers |
| Selection Information | Select |  | `edit.selectionInfo` | not in tabs; from IrfanView |
| Auto Crop Borders | Crop | Ctrl+Shift+y | `edit.autoCrop` | from IrfanView |
| Crop for Print Size… | Crop |  | `edit.cropPrint` | from Picasa |
| Crop Page from Photo | Crop |  | `edit.cropPage` | from new in Anne's Lens |
| Crop Selection | Crop | Ctrl+y | `edit.crop` | from IrfanView |
| Crop to Aspect Ratio… | Crop |  | `edit.cropAspect` | from Microsoft Photos, Preview, Apple Photos and iPhoto |
| Add Border or Frame… | Add |  | `edit.border` | from IrfanView, FastStone Image Viewer |
| Change Canvas Size… | Add | Shift+v | `edit.canvasSize` | from IrfanView |
| Insert Text… | Add | Ctrl+t | `edit.insertText` | from IrfanView |
| Insert Watermark or Overlay… | Add |  | `edit.insertOverlay` | from IrfanView, FastStone Image Viewer |
| Signature… | Add |  | `edit.signature` | from Preview |
| Arrow | Paint and markup |  | `paint.arrow` | not in tabs; from IrfanView, FastStone Image Viewer |
| Brush | Paint and markup |  | `paint.brush` | not in tabs; from IrfanView |
| Clone Stamp | Paint and markup |  | `paint.clone` | not in tabs; from IrfanView, FastStone Image Viewer |
| Color Picker | Paint and markup |  | `paint.colorPicker` | not in tabs; from IrfanView, ImageGlass |
| Color Replacer Brush | Paint and markup |  | `paint.colorReplace` | not in tabs; from IrfanView |
| Ellipse | Paint and markup |  | `paint.ellipse` | not in tabs; from IrfanView |
| Eraser | Paint and markup |  | `paint.eraser` | not in tabs; from IrfanView |
| Flatten Markup | Paint and markup |  | `edit.flattenMarkup` | from new in Anne's Lens |
| Flood Fill | Paint and markup |  | `paint.fill` | not in tabs; from IrfanView |
| Healing Brush | Paint and markup |  | `paint.heal` | not in tabs; from FastStone Image Viewer, Picasa |
| Line | Paint and markup |  | `paint.line` | not in tabs; from IrfanView |
| Magnifier Callout | Paint and markup |  | `edit.callout` | from new in Anne's Lens |
| Markup Board | Paint and markup | Ctrl+Shift+d | `edit.markup` | from FastStone Image Viewer, Preview, Microsoft Photos |
| Paint Tools | Paint and markup | F12 | `edit.paint` | from IrfanView |
| Pencil | Paint and markup |  | `paint.pencil` | not in tabs; from IrfanView |
| Rectangle | Paint and markup |  | `paint.rect` | not in tabs; from IrfanView |
| Red-Eye Brush | Paint and markup |  | `paint.redEye` | not in tabs; from IrfanView, Picasa |
| Redact Region (blur, pixelate, black out) | Paint and markup |  | `edit.redact` | from FastStone Image Viewer, new in Anne's Lens |
| Spray | Paint and markup |  | `paint.spray` | not in tabs; from IrfanView |
| Text Tool | Paint and markup |  | `paint.text` | not in tabs; from IrfanView |
| Find Files… | Find | Ctrl+f | `edit.findFiles` | from IrfanView, XnView Classic and XnView MP |
| Go to File by Name | Find | Ctrl+Shift+g | `edit.gotoFile` | from new in Anne's Lens |

## Image (45 of 45)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Count Unique Colors | Information |  | `image.countColors` | from IrfanView |
| Estimate JPEG Quality | Information |  | `image.jpegQuality` | from XnView Classic and XnView MP, new in Anne's Lens |
| Histogram | Information | Shift+h | `image.histogram` | from IrfanView, XnView Classic and XnView MP, FastStone Image Viewer |
| Picture Information | Information | i | `image.info` | from IrfanView, most picture viewers |
| Show Channel | Information |  | `image.showChannel` | has options menu; not in tabs; from IrfanView, XnView Classic and XnView MP |
| DICOM Tags… | Scientific pictures |  | `image.dicomTags` | from new in Anne's Lens |
| FITS Header… | Scientific pictures |  | `image.fitsHeader` | from new in Anne's Lens |
| FITS Stretch… | Scientific pictures |  | `image.fitsStretch` | from new in Anne's Lens |
| Window / Level… | Scientific pictures |  | `image.dicomWindow` | from new in Anne's Lens |
| Auto Straighten | Rotate and flip |  | `image.autoStraighten` | from Lightroom Classic (Library and Develop), new in Anne's Lens |
| Auto-Rotate by EXIF Orientation | Rotate and flip |  | `image.autoRotateExif` | from IrfanView, XnView Classic and XnView MP |
| Custom Rotation… | Rotate and flip | Ctrl+u | `image.rotateCustom` | from IrfanView |
| Deskew Scanned Page | Rotate and flip |  | `image.deskew` | from Kodak/Wang Imaging for Windows, new in Anne's Lens |
| Flip Horizontal | Rotate and flip | h | `image.flipH` | from IrfanView |
| Flip Vertical | Rotate and flip | v | `image.flipV` | from IrfanView |
| Lens Correction… | Rotate and flip |  | `image.lensCorrection` | from digiKam, Lightroom Classic (Library and Develop) |
| Perspective Correction… | Rotate and flip |  | `image.perspective` | from Lightroom Classic (Library and Develop), PhotoScape |
| Rotate 180° | Rotate and flip |  | `image.rotate180` |  |
| Rotate Left | Rotate and flip | l | `image.rotateLeft` | from IrfanView, most picture viewers |
| Rotate Right | Rotate and flip | r | `image.rotateRight` | from IrfanView, most picture viewers |
| Straighten | Rotate and flip |  | `image.straighten` | from Picasa, Microsoft Photos, Apple Photos and iPhoto |
| Lossless Auto-Rotate by EXIF | Lossless JPEG | Ctrl+Alt+a | `image.losslessAutoRotate` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Lossless Crop | Lossless JPEG | Ctrl+Shift+j | `image.losslessCrop` | from IrfanView, XnView Classic and XnView MP |
| Lossless JPEG Transformations… | Lossless JPEG | Shift+j | `image.losslessJpeg` | from IrfanView, XnView Classic and XnView MP, FastStone Image Viewer |
| Content-Aware Resize… | Size |  | `image.seamCarve` | from new in Anne's Lens |
| Double Size | Size | Shift+- | `image.doubleSize` | from IrfanView |
| Half Size | Size | Shift+- | `image.halfSize` | from IrfanView |
| Resize / Resample… | Size | Ctrl+r | `image.resize` | from IrfanView |
| Resize to Screen | Size |  | `image.resizeToScreen` | from IrfanView |
| Set Print Resolution (DPI)… | Size |  | `image.setDpi` | from IrfanView |
| Alpha from Mask… | Color depth and palette |  | `image.alphaFromMask` | from new in Anne's Lens |
| Black and White (Threshold)… | Color depth and palette |  | `image.threshold` | from IrfanView |
| Convert to Grayscale | Color depth and palette | Ctrl+g | `image.grayscale` | from IrfanView |
| Decrease Color Depth… | Color depth and palette |  | `image.decreaseDepth` | from IrfanView |
| Edit Palette… | Color depth and palette |  | `image.paletteEdit` | from IrfanView |
| Flatten Transparency | Color depth and palette |  | `image.flatten` |  |
| Import Palette… | Color depth and palette |  | `image.paletteImport` | from IrfanView |
| Increase Color Depth | Color depth and palette |  | `image.increaseDepth` | from IrfanView |
| Negative | Color depth and palette | Ctrl+Shift+n | `image.negative` | has options menu; from IrfanView |
| Replace Color… | Color depth and palette |  | `image.replaceColor` | from IrfanView |
| Swap Color Channels | Color depth and palette |  | `image.swapChannels` | has options menu; from IrfanView |
| Transparent Color… | Color depth and palette |  | `image.transparentColor` | from IrfanView, Graphic Workshop |
| Assign Color Profile… | Color management |  | `image.assignProfile` | from digiKam |
| Convert to Color Profile… | Color management |  | `image.convertProfile` | from digiKam, XnView Classic and XnView MP |
| Soft Proof… | Color management |  | `image.softProof` | from Lightroom Classic (Library and Develop), new in Anne's Lens |

## Adjust (47 of 47)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Auto Color | Automatic |  | `adjust.autoColor` | from XnView Classic and XnView MP |
| Auto Contrast | Automatic |  | `adjust.autoContrast` | from XnView Classic and XnView MP |
| Auto Levels | Automatic |  | `adjust.autoLevels` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Auto White Balance | Automatic |  | `adjust.autoWhiteBalance` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Auto-Adjust Colors | Automatic | Shift+u | `adjust.auto` | from IrfanView |
| One-Click Enhance | Automatic | Ctrl+e | `adjust.enhance` | from Picasa, Microsoft Photos, Apple Photos and iPhoto |
| Brightness and Contrast… | Tone |  | `adjust.brightnessContrast` | from most picture viewers |
| Clarity… | Tone |  | `adjust.clarity` | from Apple Photos and iPhoto, Lightroom Classic (Library and Develop) |
| Color Corrections… | Tone | Shift+g | `adjust.colorCorrections` | from IrfanView |
| Curves… | Tone | Ctrl+Shift+u | `adjust.curves` | from FastStone Image Viewer, XnView Classic and XnView MP, digiKam |
| Dehaze… | Tone |  | `adjust.dehaze` | from Lightroom Classic (Library and Develop) |
| Equalize Histogram | Tone |  | `adjust.equalize` | from XnView Classic and XnView MP |
| Exposure… | Tone |  | `adjust.exposure` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Fill Light | Tone |  | `adjust.fillLight` | from Picasa |
| Gamma… | Tone |  | `adjust.gamma` | from IrfanView |
| Levels… | Tone | Ctrl+l | `adjust.levels` | from FastStone Image Viewer, XnView Classic and XnView MP |
| Normalize | Tone |  | `adjust.normalize` | from XnView Classic and XnView MP |
| Shadows and Highlights… | Tone |  | `adjust.shadowsHighlights` | from FastStone Image Viewer, Lightroom Classic (Library and Develop) |
| Tone Equalizer… | Tone |  | `adjust.toneEqualizer` | from ACDSee, JPEGView |
| Vignette… | Tone |  | `adjust.vignette` | from Apple Photos and iPhoto, Lightroom Classic (Library and Develop), FastStone Image Viewer |
| Apply LUT… | Color |  | `adjust.lut` | from new in Anne's Lens |
| Black-and-White Mixer… | Color |  | `adjust.bwMixer` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Channel Mixer… | Color |  | `adjust.channelMixer` | from XnView Classic and XnView MP, digiKam |
| Color Balance… | Color |  | `adjust.colorBalance` | from FastStone Image Viewer, XnView Classic and XnView MP |
| Hue, Saturation and Lightness… | Color |  | `adjust.hsl` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Posterize… | Color |  | `adjust.posterize` | from XnView Classic and XnView MP |
| Selective Color… | Color |  | `adjust.selectiveColor` | from Apple Photos and iPhoto |
| Tint and Sepia… | Color |  | `adjust.tint` | from Picasa, XnView Classic and XnView MP |
| Vibrance… | Color |  | `adjust.vibrance` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Warmify | Color |  | `adjust.warmify` | from Picasa |
| White Balance… | Color |  | `adjust.whiteBalance` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Blur… | Detail and retouch |  | `adjust.blur` | from IrfanView |
| Descreen (moiré) | Detail and retouch |  | `adjust.descreen` | from new in Anne's Lens |
| Despeckle | Detail and retouch |  | `adjust.despeckle` | from XnView Classic and XnView MP |
| Noise Reduction… | Detail and retouch |  | `adjust.denoise` | from Lightroom Classic (Library and Develop), digiKam |
| Red-Eye Reduction | Detail and retouch | Shift+y | `adjust.redEye` | from IrfanView, Picasa, Microsoft Photos |
| Remove Dust and Scratches… | Detail and retouch |  | `adjust.dustScratches` | from new in Anne's Lens |
| Restore Faded Colors | Detail and retouch |  | `adjust.restoreFaded` | from new in Anne's Lens |
| Sharpen | Detail and retouch | Shift+s | `adjust.sharpen` | from IrfanView |
| Unsharp Mask… | Detail and retouch |  | `adjust.unsharp` | from IrfanView, XnView Classic and XnView MP |
| Apply Preset | Presets and history |  | `adjust.applyPreset` | has options menu; from Lightroom Classic (Library and Develop) |
| Before / After | Presets and history | \ | `adjust.beforeAfter` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Copy Adjustments | Presets and history | Ctrl+Shift+c | `adjust.copySettings` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Paste Adjustments | Presets and history | Ctrl+Alt+v | `adjust.pasteSettings` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto |
| Reset All Adjustments | Presets and history |  | `adjust.resetAll` | from Apple Photos and iPhoto, Picasa |
| Revert to Original | Presets and history |  | `adjust.revertOriginal` | from Apple Photos and iPhoto, Microsoft Photos, Picasa |
| Save Adjustment Preset… | Presets and history |  | `adjust.savePreset` | from Lightroom Classic (Library and Develop), FastStone Image Viewer |

## Effects (46 of 47)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Custom Filter (Convolution)… | Browse |  | `fx.convolution` | from IrfanView, XnView Classic and XnView MP |
| Effects Browser… | Browse |  | `fx.browser` | from IrfanView |
| Repeat Last Effect | Browse | Ctrl+Alt+r | `fx.repeatLast` | from new in Anne's Lens |
| 3-D Button | Artistic |  | `fx.button3d` | from IrfanView |
| Cartoon | Artistic |  | `fx.cartoon` | from FastStone Image Viewer |
| Edge Detect | Artistic |  | `fx.edgeDetect` | from IrfanView |
| Emboss | Artistic |  | `fx.emboss` | from IrfanView |
| Halftone | Artistic |  | `fx.halftone` | from new in Anne's Lens |
| Median | Artistic |  | `fx.median` | from IrfanView |
| Mosaic | Artistic |  | `fx.mosaic` | from XnView Classic and XnView MP |
| Oil Paint | Artistic |  | `fx.oilPaint` | from IrfanView |
| Pencil Sketch | Artistic |  | `fx.pencilSketch` | from FastStone Image Viewer |
| Pixelate | Artistic |  | `fx.pixelize` | from IrfanView |
| Solarize | Artistic |  | `fx.solarize` | from IrfanView |
| Tiles | Artistic |  | `fx.tiles` | from IrfanView |
| Watercolor | Artistic |  | `fx.watercolor` | from new in Anne's Lens |
| Add Noise | Photographic |  | `fx.noise` | from XnView Classic and XnView MP |
| Cross Process | Photographic |  | `fx.crossProcess` | from new in Anne's Lens |
| Duotone | Photographic |  | `fx.duotone` | from new in Anne's Lens |
| Film Grain | Photographic |  | `fx.filmGrain` | from Picasa |
| Focal Black and White | Photographic |  | `fx.focalBW` | from Picasa |
| Glow | Photographic |  | `fx.glow` | from Picasa |
| Graduated Tint | Photographic |  | `fx.graduatedTint` | from Picasa |
| Orton Glow | Photographic |  | `fx.orton` | from new in Anne's Lens |
| Soft Focus | Photographic |  | `fx.softFocus` | from Picasa |
| Tilt-Shift Miniature | Photographic |  | `fx.tiltShift` | from new in Anne's Lens |
| Toy Camera | Photographic |  | `fx.toyCamera` | from new in Anne's Lens |
| Explosion | Distort |  | `fx.explosion` | from IrfanView |
| Fisheye | Distort |  | `fx.fishEye` | from IrfanView |
| Fragment | Distort |  | `fx.fragment` | from IrfanView |
| Glass | Distort |  | `fx.glass` | from new in Anne's Lens |
| Pinch | Distort |  | `fx.pinch` | from XnView Classic and XnView MP |
| Polar Coordinates | Distort |  | `fx.polar` | from new in Anne's Lens |
| Radial Blur | Distort |  | `fx.radialBlur` | from IrfanView |
| Rain Drops | Distort |  | `fx.rain` | from IrfanView |
| Ripple | Distort |  | `fx.ripple` | from XnView Classic and XnView MP |
| Shift Lines | Distort |  | `fx.shift` | from IrfanView |
| Spread | Distort |  | `fx.spread` | from IrfanView |
| Swirl | Distort |  | `fx.swirl` | from IrfanView |
| Wave | Distort |  | `fx.wave` | from IrfanView |
| Zoom Blur | Distort |  | `fx.zoomBlur` | from IrfanView |
| Drop Shadow | Frames and shadows |  | `fx.dropShadow` | from FastStone Image Viewer |
| Instant-Print Frame | Frames and shadows |  | `fx.instantFrame` | from Picasa |
| Reflection | Frames and shadows |  | `fx.reflection` | from FastStone Image Viewer |
| Round Corners | Frames and shadows |  | `fx.roundCorners` | from FastStone Image Viewer |
| Vignette Frame | Frames and shadows |  | `fx.vignetteFrame` | from FastStone Image Viewer |

## Browse (42 of 42)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Add to Album… | Views | Ctrl+Shift+k | `browse.addToAlbum` | from Picasa, digiKam |
| Albums | Views |  | `browse.albums` | from Picasa, digiKam, gThumb, Geeqie (GQview) |
| Browser | Views | F3 | `browse.browser` | from XnView Classic and XnView MP, FastStone Image Viewer, ACDSee |
| Favorite Folders | Views |  | `browse.favorites` | has options menu; from XnView Classic and XnView MP, FastStone Image Viewer |
| Filter Bar | Views | Ctrl+Shift+f | `browse.filter` | from XnView Classic and XnView MP, Lightroom Classic (Library and Develop) |
| Folder Tree | Views |  | `browse.folderTree` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Group By | Views |  | `browse.groupBy` | has options menu; from XnView Classic and XnView MP, digiKam |
| Include Subfolders | Views |  | `browse.recursive` | from IrfanView, XnView Classic and XnView MP |
| Map | Views |  | `browse.map` | from Picasa, digiKam, XnView Classic and XnView MP, Apple Photos and iPhoto |
| Open Archive as Folder | Views |  | `browse.openArchive` | from Honeyview, XnView Classic and XnView MP |
| Open Shared Album… | Views |  | `browse.openSharedAlbum` | from Google Photos, Apple Photos and iPhoto, new in Anne's Lens |
| People | Views | Ctrl+F6 | `browse.people` | from Picasa, digiKam, Apple Photos and iPhoto, Google Photos, ACDSee, Windows Live Photo Gallery |
| Share Album… | Views |  | `browse.shareAlbum` | from Google Photos, Apple Photos and iPhoto, new in Anne's Lens |
| Show All Files | Views |  | `browse.showAllFiles` | from XnView Classic and XnView MP |
| Smart Albums | Views |  | `browse.smartAlbum` | from Apple Photos and iPhoto, digiKam, Lightroom Classic (Library and Develop) |
| Sort By | Views |  | `browse.sort` | has options menu; from IrfanView, XnView Classic and XnView MP |
| Thumbnail Size | Views |  | `browse.thumbSize` | has options menu; from IrfanView, XnView Classic and XnView MP |
| Thumbnails | Views | t | `browse.thumbnails` | from IrfanView |
| Timeline | Views |  | `browse.timeline` | from Picasa, digiKam, ACDSee |
| View Mode | Views |  | `browse.viewMode` | has options menu; from XnView Classic and XnView MP, ACDSee |
| Color Label | Rate and label |  | `browse.colorLabel` | has options menu; from XnView Classic and XnView MP, Lightroom Classic (Library and Develop), ACDSee |
| Favorite | Rate and label | Ctrl+Shift+8 | `browse.favorite` | from Picasa, Apple Photos and iPhoto, Google Photos |
| Pick | Rate and label |  | `browse.pick` | from Lightroom Classic (Library and Develop), FastPictureViewer |
| Rating | Rate and label |  | `browse.rate` | has options menu; from XnView Classic and XnView MP, Lightroom Classic (Library and Develop), ACDSee |
| Reject | Rate and label |  | `browse.reject` | from Lightroom Classic (Library and Develop), FastPictureViewer |
| Select by Pattern… | Rate and label |  | `browse.selectPattern` | from XnView Classic and XnView MP |
| Select Rejected | Rate and label |  | `browse.selectRejected` | from Lightroom Classic (Library and Develop) |
| Unflag | Rate and label |  | `browse.unflag` | from Lightroom Classic (Library and Develop) |
| Cull Mode | Find and compare | Ctrl+Alt+c | `browse.cull` | from new in Anne's Lens, FastPictureViewer, Lightroom Classic (Library and Develop) |
| Find Duplicates… | Find and compare |  | `browse.findDuplicates` | from XnView Classic and XnView MP, digiKam, gThumb, ThumbsPlus |
| Find Similar Pictures… | Find and compare |  | `browse.findSimilar` | from XnView Classic and XnView MP, digiKam, Geeqie (GQview) |
| Light Table | Find and compare |  | `browse.lightTable` | from FastStone Image Viewer, digiKam |
| Search by Color | Find and compare |  | `browse.searchColor` | from digiKam, new in Anne's Lens |
| Search by Sketch | Find and compare |  | `browse.searchSketch` | from digiKam |
| Sort by Quality | Find and compare |  | `browse.qualitySort` | from digiKam |
| Stack Bursts and Versions | Find and compare |  | `browse.stacks` | from Lightroom Classic (Library and Develop), Apple Photos and iPhoto, new in Anne's Lens |
| Catalog Maintenance… | Catalog |  | `browse.maintenance` | from digiKam, ACDSee |
| Folder Manager… | Catalog |  | `browse.folderManager` | from Picasa |
| New Folder | Catalog |  | `browse.newFolder` | not in tabs; from XnView Classic and XnView MP |
| Refresh | Catalog | F5 | `browse.refresh` | from XnView Classic and XnView MP, IrfanView |
| Use Catalog | Catalog |  | `browse.catalog` | from ACDSee, digiKam, XnView Classic and XnView MP |
| Watch Folder… | Catalog |  | `browse.watchFolder` | from new in Anne's Lens |

## Metadata (26 of 26)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Comment… | View and edit | Ctrl+Shift+m | `meta.comment` | from IrfanView |
| Compare Metadata | View and edit |  | `meta.diff` | from new in Anne's Lens |
| Copy Metadata From… | View and edit |  | `meta.copyFrom` | from XnView Classic and XnView MP |
| Creator and Copyright… | View and edit |  | `meta.copyright` | from XnView Classic and XnView MP, digiKam |
| EXIF Information | View and edit | e | `meta.exif` | from IrfanView, most picture viewers |
| IPTC Information… | View and edit |  | `meta.iptc` | from IrfanView, XnView Classic and XnView MP |
| Keywords… | View and edit | Ctrl+k | `meta.keywords` | from digiKam, XnView Classic and XnView MP, Lightroom Classic (Library and Develop) |
| Metadata Template… | View and edit |  | `meta.template` | from digiKam, Lightroom Classic (Library and Develop), XnView Classic and XnView MP |
| Region Tags… | View and edit |  | `meta.regions` | from digiKam, Picasa |
| Title and Caption… | View and edit | Ctrl+Shift+t | `meta.caption` | from Picasa, digiKam, Apple Photos and iPhoto |
| Write Sidecar or Embed | View and edit |  | `meta.sidecarMode` | has options menu; from digiKam, Lightroom Classic (Library and Develop) |
| XMP… | View and edit |  | `meta.xmp` | from XnView Classic and XnView MP, digiKam |
| Change Date Taken… | Date and place |  | `meta.shiftDate` | from IrfanView, XnView Classic and XnView MP, digiKam |
| Geotag from GPS Track… | Date and place |  | `meta.geotagGpx` | from digiKam, Geeqie (GQview) |
| Look Up Place Names | Date and place |  | `meta.reverseGeocode` | from Apple Photos and iPhoto, new in Anne's Lens |
| Remove Location | Date and place |  | `meta.removeGps` | from Microsoft Photos, new in Anne's Lens |
| Set Location… | Date and place |  | `meta.geotag` | from Picasa, digiKam, XnView Classic and XnView MP |
| Checksum… | Privacy and integrity |  | `meta.checksum` | from new in Anne's Lens |
| Content Credentials | Privacy and integrity |  | `meta.provenance` | from new in Anne's Lens |
| Fixity Report… | Privacy and integrity |  | `meta.fixity` | from new in Anne's Lens |
| Privacy Check | Privacy and integrity |  | `meta.privacyCheck` | from new in Anne's Lens |
| Strip Metadata… | Privacy and integrity |  | `meta.strip` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Export Metadata as CSV… | Records and genealogy |  | `meta.exportCsv` | from XnView Classic and XnView MP, digiKam |
| Import Metadata from CSV… | Records and genealogy |  | `meta.importCsv` | from new in Anne's Lens |
| Link Person… | Records and genealogy |  | `meta.personLink` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration), new in Anne's Lens |
| Source Citation… | Records and genealogy |  | `meta.citation` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration), new in Anne's Lens |

## Batch (13 of 13)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Batch Conversion and Rename… | Batch | b | `batch.convert` | from IrfanView |
| Batch Lossless JPEG… | Batch |  | `batch.lossless` | from IrfanView, XnView Classic and XnView MP |
| Batch Metadata… | Batch |  | `batch.metadata` | from XnView Classic and XnView MP, digiKam |
| Batch Multipage… | Batch |  | `batch.multipage` | from IrfanView |
| Batch Queue | Batch |  | `batch.queue` | from digiKam |
| Batch Rename… | Batch | Ctrl+b | `batch.rename` | from IrfanView, XnView Classic and XnView MP, FastStone Image Viewer |
| Batch Steps… | Batch |  | `batch.actions` | from IrfanView, XnView Classic and XnView MP |
| Batch Watermark… | Batch |  | `batch.watermark` | from FastStone Image Viewer, XnView Classic and XnView MP |
| Optimize Files… | Batch |  | `batch.optimize` | from IrfanView, new in Anne's Lens |
| Preview Batch (Dry Run) | Batch |  | `batch.dryRun` | from new in Anne's Lens |
| Recipe Editor… | Batch |  | `batch.recipe` | from XnView Classic and XnView MP, digiKam |
| Undo Last Batch | Batch |  | `batch.undo` | from new in Anne's Lens |
| Web and Email Sizes… | Batch |  | `batch.webPresets` | has options menu; from Windows Photo Viewer and Windows Picture and Fax Viewer, Picasa |

## Create (17 of 17)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Animation from Pictures… | Create |  | `create.animation` | from XnView Classic and XnView MP, new in Anne's Lens |
| Calendar Page… | Create |  | `create.calendar` | from PhotoScape, new in Anne's Lens |
| Collage… | Create |  | `create.collage` | from Picasa, Windows Live Photo Gallery, Google Photos |
| Comparison Picture… | Create |  | `create.comparison` | from new in Anne's Lens |
| Contact Sheet… | Create |  | `create.contactSheet` | from IrfanView, XnView Classic and XnView MP, FastStone Image Viewer, Preview |
| Exposure Merge (HDR)… | Create |  | `create.hdr` | from digiKam, Lightroom Classic (Library and Develop) |
| Extract All Frames… | Create |  | `create.extractFrames` | from IrfanView |
| Extract Embedded Pictures… | Create |  | `create.extractEmbedded` | from IrfanView, new in Anne's Lens |
| Focus Stack… | Create |  | `create.focusStack` | from new in Anne's Lens |
| Icon Set… | Create |  | `create.icon` | from new in Anne's Lens |
| Image Strip… | Create |  | `create.imageStrip` | from XnView Classic and XnView MP, FastStone Image Viewer |
| Join Side by Side… | Create |  | `create.panoramaJoin` | from IrfanView, FastStone Image Viewer |
| Multipage TIFF or PDF… | Create |  | `create.multipage` | from IrfanView |
| Photo Book in Anne's Press | Create |  | `create.photoBook` | from the Anne's Office suite |
| Slideshow Video… | Create |  | `create.movie` | from Picasa, Google Photos, Microsoft Photos |
| Stitch Panorama… | Create |  | `create.panoramaStitch` | from Windows Live Photo Gallery, digiKam |
| Web Gallery… | Create |  | `create.webGallery` | from XnView Classic and XnView MP, gThumb, digiKam, IrfanView |

## Pages and Frames (15 of 15)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Delete Page | Pages |  | `pages.delete` | from IrfanView |
| Extract Pages… | Pages |  | `pages.extract` | from IrfanView |
| Go to Page… | Pages |  | `pages.goto` | from IrfanView |
| Insert Pages… | Pages |  | `pages.insert` | from IrfanView |
| Next Page | Pages | Ctrl+PageDown | `pages.next` | from IrfanView |
| Previous Page | Pages | Ctrl+PageUp | `pages.previous` | from IrfanView |
| Reorder Pages… | Pages |  | `pages.reorder` | from IrfanView |
| Animation Speed | Frames |  | `frames.speed` | has options menu; from new in Anne's Lens |
| Frame Editor… | Frames |  | `frames.editor` | from XnView Classic and XnView MP, new in Anne's Lens |
| Loop Count… | Frames |  | `frames.loopCount` | from XnView Classic and XnView MP |
| Next Frame | Frames | . | `frames.next` | from XnView Classic and XnView MP |
| Optimize Animation | Frames |  | `frames.optimize` | from new in Anne's Lens |
| Play / Pause Animation | Frames | Ctrl+Space | `frames.play` | from IrfanView, XnView Classic and XnView MP |
| Previous Frame | Frames |  | `frames.previous` | from XnView Classic and XnView MP |
| Reverse Frames | Frames |  | `frames.reverse` | from new in Anne's Lens |

## RAW (4 of 4)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Develop RAW… | RAW |  | `raw.develop` | from XnView Classic and XnView MP, digiKam, Lightroom Classic (Library and Develop) |
| Extract Embedded Preview | RAW |  | `raw.extractPreview` | from new in Anne's Lens |
| Show Embedded Preview | RAW |  | `raw.preview` | from IrfanView, XnView Classic and XnView MP, FastStone Image Viewer |
| Use Embedded Preview by Default | RAW |  | `raw.preferPreview` | from IrfanView, FastStone Image Viewer |

## View (77 of 77)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Center Picture | Zoom |  | `view.center` | from IrfanView |
| Fill Window | Zoom |  | `view.fill` | from ImageGlass |
| Fit Height | Zoom |  | `view.fitHeight` | from IrfanView |
| Fit Only Large Pictures | Zoom |  | `view.fitLarge` | from IrfanView |
| Fit to Window | Zoom | Shift+f | `view.fitWindow` | from IrfanView |
| Fit Width | Zoom |  | `view.fitWidth` | from IrfanView |
| Fit Window to Picture | Zoom |  | `view.fitWindowToImage` | from IrfanView |
| Keep Position | Zoom |  | `view.keepPosition` | from XnView Classic and XnView MP, new in Anne's Lens |
| Lock Zoom | Zoom |  | `view.zoomLock` | from IrfanView, XnView Classic and XnView MP |
| Original Size | Zoom | Ctrl+h | `view.actualSize` | from IrfanView |
| Zoom In | Zoom | +, = | `view.zoomIn` | from IrfanView, most picture viewers |
| Zoom Out | Zoom | + | `view.zoomOut` | from IrfanView, most picture viewers |
| First Picture | Navigate | Home | `view.first` | from IrfanView |
| Go to Picture Number… | Navigate | Ctrl+j | `view.gotoIndex` | from new in Anne's Lens |
| Last Picture | Navigate | End | `view.last` | from IrfanView |
| Next Folder | Navigate | Ctrl+ArrowRight | `view.nextFolder` | from XnView Classic and XnView MP, Honeyview |
| Next Picture | Navigate | Space, PageDown, ArrowRight | `view.next` | from IrfanView, most picture viewers |
| Previous Folder | Navigate | Ctrl+ArrowLeft | `view.previousFolder` | from XnView Classic and XnView MP, Honeyview |
| Previous Picture | Navigate | Backspace, PageUp, ArrowLeft | `view.previous` | from IrfanView, most picture viewers |
| Random Picture | Navigate | Ctrl+m | `view.random` | from XnView Classic and XnView MP, IrfanView |
| Wrap Around at Ends | Navigate |  | `view.wrap` | from IrfanView, XnView Classic and XnView MP |
| Always on Top | Window |  | `view.alwaysOnTop` | from IrfanView, XnView Classic and XnView MP |
| Classic Menu Layout | Window |  | `view.menuLayout` | has options menu; from new in Anne's Lens |
| Collapse the Ribbon | Window | Ctrl+F1 | `view.collapseRibbon` | from the Anne's Office suite |
| Filmstrip | Window | Ctrl+Shift+b | `view.filmstrip` | from XnView Classic and XnView MP, FastStone Image Viewer, Microsoft Photos |
| Frameless Window | Window |  | `view.frameless` | from nomacs, ImageGlass |
| Full Screen | Window | Enter, F11 | `view.fullScreen` | from IrfanView, most picture viewers |
| Full Screen on Another Display | Window |  | `view.fullScreenDisplay` | from new in Anne's Lens |
| Info Pane | Window | Ctrl+i | `view.infoPane` | from XnView Classic and XnView MP, FastStone Image Viewer, Preview |
| Language… | Window |  | `view.language` | from IrfanView |
| Menus | Window |  | `view.menuMode` | from the Anne's Office suite |
| Minimize | Window | m | `view.minimize` | from IrfanView |
| Navigator | Window |  | `view.navigator` | from XnView Classic and XnView MP, ImageGlass |
| Status Bar | Window |  | `view.statusBar` | from IrfanView |
| Theme | Window |  | `view.theme` | has options menu |
| Toolbar | Window |  | `view.toolbar` | from IrfanView |
| Touch/Mouse Mode | Window |  | `view.touchMode` | from the Anne's Office suite |
| Clipping Warnings | Inspect | j | `view.clipping` | from Lightroom Classic (Library and Develop) |
| Copy Color Under Pointer | Inspect | Ctrl+Shift+p | `view.copyColor` | from ImageGlass, IrfanView |
| Focus Peaking | Inspect |  | `view.focusPeaking` | from FastRawViewer |
| Grid and Guides | Inspect |  | `view.grid` | has options menu; from new in Anne's Lens |
| Histogram Overlay | Inspect | Shift+o | `view.histogramOverlay` | from FastStone Image Viewer, XnView Classic and XnView MP |
| Information Overlay | Inspect | Ctrl+Alt+o | `view.osd` | from ImageGlass, FastStone Image Viewer, XnView Classic and XnView MP |
| Loupe | Inspect | z | `view.loupe` | from FastStone Image Viewer, Preview, Lightroom Classic (Library and Develop) |
| Measure | Inspect |  | `view.measure` | has options menu; from new in Anne's Lens |
| Overlay Template… | Inspect |  | `view.osdTemplate` | from XnView Classic and XnView MP |
| Pixel Grid | Inspect |  | `view.pixelGrid` | from new in Anne's Lens |
| Pixel Information | Inspect |  | `view.pixelInfo` | from IrfanView, ImageGlass |
| Rulers | Inspect |  | `view.rulers` | from new in Anne's Lens |
| 360° View | Display |  | `view.sphere` | from Google Photos |
| Background Color… | Display |  | `view.background` | from IrfanView |
| Color-Blindness Simulation | Display |  | `view.colorBlindSim` | has options menu; from new in Anne's Lens |
| Color-Managed Display | Display |  | `view.colorManaged` | from XnView Classic and XnView MP, digiKam |
| DICOM Overlay Planes | Display |  | `view.dicomOverlays` | from new in Anne's Lens |
| Display Adjustments | Display |  | `view.displayAdjust` | from JPEGView, new in Anne's Lens |
| Grayscale Preview | Display |  | `view.grayscalePreview` | from new in Anne's Lens |
| Right-to-Left Reading | Display |  | `view.rtl` | from Honeyview |
| Stereo View | Display |  | `view.stereo` | has options menu; from Geeqie (GQview) |
| Transparency Display | Display |  | `view.alphaDisplay` | has options menu; from XnView Classic and XnView MP, ImageGlass |
| Two-Page View | Display |  | `view.twoPage` | from Honeyview |
| Before/After Slider | Compare |  | `view.compareSplit` | has options menu; from new in Anne's Lens |
| Compare Pictures | Compare | Ctrl+Alt+y | `view.compare` | from FastStone Image Viewer, XnView Classic and XnView MP, nomacs, digiKam |
| Difference Overlay | Compare |  | `view.diffOverlay` | from new in Anne's Lens |
| Follow a Shared View… | Compare |  | `view.followView` | from nomacs, new in Anne's Lens |
| Network Relay… | Compare |  | `view.netRelay` | not in tabs; from the Anne's Office suite, new in Anne's Lens |
| Share View on the Network | Compare |  | `view.shareView` | from nomacs, new in Anne's Lens |
| Synchronize Windows | Compare |  | `view.syncWindows` | from nomacs |
| Media Player | Media |  | `view.media` | from IrfanView, XnView Classic and XnView MP, new in Anne's Lens |
| Motion Photo | Media |  | `view.motionPhoto` | from Apple Photos and iPhoto, Google Photos |
| Play / Pause | Media | k | `view.mediaPlay` | from IrfanView, Microsoft Photos |
| Save Current Frame | Media |  | `view.mediaFrame` | from IrfanView, Microsoft Photos |
| Add All Choices to Quick Access Bar | Quick Access Bar and search |  | `view.qatAddAll` | from the Anne's Office suite |
| Hide Quick Access Bar | Quick Access Bar and search |  | `view.qatHide` | from the Anne's Office suite |
| Quick Access Bar Labels | Quick Access Bar and search |  | `view.qatLabels` | from the Anne's Office suite |
| Quick Access Bar Position | Quick Access Bar and search |  | `view.qatPosition` | has options menu; from the Anne's Office suite |
| Search Commands | Quick Access Bar and search | Alt+q | `view.cmdSearch` | from the Anne's Office suite |
| Show Quick Access Bar | Quick Access Bar and search |  | `view.qatShow` | not in tabs; from the Anne's Office suite |

## Slideshow (13 of 13)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Background Music… | Slideshow |  | `show.music` | from FastStone Image Viewer, Picasa |
| Captions | Slideshow |  | `show.captions` | from IrfanView, XnView Classic and XnView MP |
| Export as HTML Slideshow… | Slideshow |  | `show.exportHtml` | from FastStone Image Viewer, IrfanView |
| Kiosk Mode | Slideshow |  | `show.kiosk` | from new in Anne's Lens |
| Loop | Slideshow |  | `show.loop` | from IrfanView |
| Pause / Resume | Slideshow | Space | `show.pause` | from most picture viewers |
| Phone Remote | Slideshow |  | `show.remote` | from the Anne's Office suite |
| Random Order | Slideshow |  | `show.random` | from IrfanView |
| Slideshow Settings… | Slideshow | w | `show.settings` | from IrfanView |
| Start from Current | Slideshow | Shift+F5 | `show.fromCurrent` |  |
| Start Slideshow | Slideshow | Ctrl+F5 | `show.start` | from IrfanView, most picture viewers |
| Timing | Slideshow |  | `show.timing` | has options menu; from IrfanView |
| Transition | Slideshow |  | `show.transition` | has options menu; from FastStone Image Viewer, Picasa, Google Photos |

## Tools (14 of 14)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Make QR Code… | Text and codes |  | `tools.makeQr` | from new in Anne's Lens |
| OCR to Anne's Pen | Text and codes |  | `tools.ocrToPen` | from the Anne's Office suite |
| Read QR Code or Barcode | Text and codes |  | `tools.readCode` | from Google Photos, new in Anne's Lens |
| Recognize Text (OCR) | Text and codes | Ctrl+Shift+r | `tools.ocr` | from IrfanView, Preview, Microsoft Photos, Google Photos |
| Document Cleanup… | Documents and print |  | `tools.docCleanup` | from new in Anne's Lens |
| Print Check… | Documents and print |  | `tools.preflight` | from new in Anne's Lens |
| Print Size Calculator | Documents and print |  | `tools.printCalc` | from new in Anne's Lens |
| Restore Old Photo… | Documents and print |  | `tools.restoreWizard` | from new in Anne's Lens |
| Extract Palette… | Color and vector |  | `tools.paletteExtract` | from new in Anne's Lens |
| Trace to Vector (SVG)… | Color and vector |  | `tools.vectorize` | from new in Anne's Lens |
| Back Up Library… | Organize |  | `tools.backup` | from Picasa, digiKam |
| Compare Folders… | Organize |  | `tools.compareFolders` | from new in Anne's Lens |
| External Tools… | Extend |  | `tools.external` | from XnView Classic and XnView MP, IrfanView |
| Plug-ins… | Extend |  | `tools.plugins` | from IrfanView, XnView Classic and XnView MP |

## AI (56 of 56)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Compare Providers… | Generate |  | `ai.generateCompare` | from new in Anne's Lens |
| Generate Background… | Generate |  | `ai.generateBackground` | from Microsoft Photos, Generative-AI picture services and editors |
| Generate Picture… | Generate | Ctrl+Alt+g | `ai.generate` | from Generative-AI picture services and editors |
| Generate Vector… | Generate |  | `ai.generateVector` | from Generative-AI picture services and editors |
| Generate with References… | Generate |  | `ai.generateWithRefs` | from Generative-AI picture services and editors |
| Picture to Prompt | Generate |  | `ai.imageToPrompt` | from Generative-AI picture services and editors |
| Prompt Library… | Generate |  | `ai.promptLibrary` | from the Anne's Office suite |
| Seamless Pattern… | Generate |  | `ai.generateTile` | from Generative-AI picture services and editors |
| Sketch to Picture… | Generate |  | `ai.sketchToImage` | from Generative-AI picture services and editors |
| Variations | Generate |  | `ai.variations` | from Generative-AI picture services and editors |
| AI Noise Reduction | Edit |  | `ai.denoise` | from Lightroom Classic (Library and Develop), Generative-AI picture services and editors |
| Blur Background | Edit |  | `ai.blurBackground` | from Microsoft Photos, Google Photos |
| Colorize | Edit |  | `ai.colorize` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration), Generative-AI picture services and editors |
| Combine Group Shots… | Edit |  | `ai.combineGroupShots` | from Windows Live Photo Gallery, Google Photos |
| Edit by Instruction… | Edit | Ctrl+Alt+e | `ai.editInstruction` | from Generative-AI picture services and editors |
| Erase Object | Edit | Ctrl+Alt+x | `ai.erase` | from Microsoft Photos, Google Photos, Apple Photos and iPhoto |
| Expand Picture… | Edit |  | `ai.expand` | from Generative-AI picture services and editors |
| Generative Fill… | Edit |  | `ai.fill` | from Generative-AI picture services and editors |
| Recolor Object… | Edit |  | `ai.recolor` | from Generative-AI picture services and editors |
| Relight… | Edit |  | `ai.relight` | from Google Photos |
| Remove Background | Edit | Ctrl+Alt+b | `ai.removeBackground` | from Microsoft Photos, Preview, Apple Photos and iPhoto |
| Remove Glare and Reflections | Edit |  | `ai.removeReflection` | from Generative-AI picture services and editors |
| Repair Damage | Edit |  | `ai.repairDamage` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration), Generative-AI picture services and editors |
| Replace Background… | Edit |  | `ai.replaceBackground` | from Microsoft Photos |
| Replace Object… | Edit |  | `ai.replace` | from Generative-AI picture services and editors |
| Restyle… | Edit |  | `ai.restyle` | from Microsoft Photos, Generative-AI picture services and editors |
| Smart Crop | Edit |  | `ai.smartCrop` | from Generative-AI picture services and editors |
| Translate Text in Picture… | Edit |  | `ai.translateText` | from Google Photos |
| Unblur | Edit |  | `ai.deblur` | from Google Photos |
| Upscale | Edit | Ctrl+Alt+u | `ai.upscale` | from Microsoft Photos, Generative-AI picture services and editors |
| Depth Map | Select |  | `ai.depth` | from Generative-AI picture services and editors |
| Select by Description… | Select |  | `ai.selectByPrompt` | from Generative-AI picture services and editors |
| Select Subject | Select |  | `ai.selectSubject` | from Apple Photos and iPhoto, Preview |
| Alt Text | Understand |  | `ai.altText` | from the Anne's Office suite |
| Ask About This Picture… | Understand |  | `ai.ask` | from Generative-AI picture services and editors |
| Culling Assistant | Understand |  | `ai.cullAssist` | from Lightroom Classic (Library and Develop), Generative-AI picture services and editors |
| Describe | Understand |  | `ai.describe` | from Generative-AI picture services and editors |
| Estimate Date | Understand |  | `ai.estimateDate` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration) |
| Find Similar by Content | Understand |  | `ai.findSimilarSemantic` | from Google Photos, Generative-AI picture services and editors |
| Identify | Understand |  | `ai.identify` | from Google Photos, Apple Photos and iPhoto |
| Run on Selection… | Understand |  | `ai.batch` | from new in Anne's Lens |
| Search by Content… | Understand | Ctrl+Alt+f | `ai.searchContent` | from Google Photos, Apple Photos and iPhoto |
| Suggest Keywords | Understand |  | `ai.autoTag` | from digiKam, Generative-AI picture services and editors |
| Transcribe Handwriting | Understand |  | `ai.transcribe` | from Archive and genealogy tools (handwriting transcription, photo dating, restoration) |
| Write Caption | Understand |  | `ai.caption` | from Generative-AI picture services and editors |
| AI History | Provenance |  | `ai.history` | from new in Anne's Lens |
| Content Credentials on AI Results | Provenance |  | `ai.contentCredentials` | from Generative-AI picture services and editors |
| Active AI | Providers |  | `ai.active` | from the Anne's Office suite |
| AI and Privacy | Providers |  | `ai.privacy` | from the Anne's Office suite |
| Choose AIs… | Providers |  | `ai.ensembleMembers` | from the Anne's Office suite |
| Delete Downloaded Models | Providers |  | `ai.deleteModels` | from the Anne's Office suite |
| Providers and Models… | Providers |  | `ai.providers` | from the Anne's Office suite |
| Set Up AI… | Providers |  | `ai.setup` | from the Anne's Office suite |
| Several AIs | Providers |  | `ai.ensembleMode` | has options menu; from the Anne's Office suite |
| Show AI Discussion | Providers |  | `ai.showDeliberation` | from the Anne's Office suite |
| Stop AI | Providers | Escape | `ai.stop` | from the Anne's Office suite |

## Developer (7 of 7)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Command-Line Help | Developer |  | `dev.cliHelp` | from IrfanView |
| Export Command List (JSON) | Developer |  | `dev.exportCommands` | from the Anne's Office suite |
| Macro Editor… | Developer | Alt+F11 | `dev.macroEditor` | from the Anne's Office suite |
| Macros… | Developer | Alt+F8 | `dev.macros` | from the Anne's Office suite |
| Record Macro | Developer |  | `dev.recordMacro` | from the Anne's Office suite |
| Script Console | Developer |  | `dev.console` | from new in Anne's Lens |
| Stop Recording | Developer |  | `dev.stopRecording` | from the Anne's Office suite |

## Help (9 of 9)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| About Anne's Lens | Help |  | `help.about` | from IrfanView |
| Check for Updates | Help |  | `help.checkUpdates` | from IrfanView |
| Help | Help | F1 | `help.contents` | from most picture viewers |
| Keyboard Shortcuts | Help | Ctrl+/ | `help.shortcuts` | from IrfanView |
| Menu Map | Help |  | `help.menuMap` | from the Anne's Office suite |
| Report a Problem | Help |  | `help.reportIssue` |  |
| Send a Sample File… | Help |  | `help.sendSample` | from new in Anne's Lens |
| Supported Formats | Help |  | `help.formats` | from IrfanView, XnView Classic and XnView MP |
| What's New | Help |  | `help.whatsNew` |  |

## Planned, not yet built (1)

These ids are in the plan but have no command yet; they belong to later milestones ([ROADMAP.md](ROADMAP.md)). Nothing below is a placeholder in the app.

- **Effects** (1): `fx.plugins8bf`
