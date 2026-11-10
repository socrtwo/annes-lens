package io.github.socrtwo.quilllens;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.os.Build;
import android.os.PersistableBundle;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native file plumbing for Anne's Lens on Android.
 *
 * JS contract (all binary payloads are base64 strings without line breaks):
 * <ul>
 *   <li>openDocument({mimeTypes: string[], multiple?: boolean}) -> {uri, name, mime, data} | {files: [...]} | {canceled: true}</li>
 *   <li>saveAs({name, mime, data}) -> {uri, name} | {canceled: true}</li>
 *   <li>writeUri({uri, data}) -> {ok: true}</li>
 *   <li>readUri({uri}) -> {uri, name, mime, data}</li>
 *   <li>print({jobName}) -> void</li>
 *   <li>share({name, mime, data, title}) -> void</li>
 *   <li>getLaunchFile() -> {uri?, name, mime, data, files?: [...]} | {} (consumed once; "Share" of several pictures lists them all)</li>
 *   <li>keepAwake({on: boolean}) -> void</li>
 *   <li>event "fileOpened" -> same payload as getLaunchFile, for files opened while running</li>
 *   <li>readClipboard() -> {text} / writeClipboard({text, sensitive})</li>
 *   <li>openInApp({packageName, name, mime, data}) -> {opened: true} | {opened: false, reason: "not-installed"}:
 *       hands a picture to a sibling Anne's Office app (Anne's Pen, Anne's Stage, Anne's Folio, Anne's Press) with ACTION_VIEW</li>
 *   <li>renameDocument({uri, name}) -> {uri, name}; deleteDocument({uri}) -> {ok: true} (Storage Access Framework)</li>
 *   <li>pickFolder({title}) -> {uri, name} | {canceled: true}: ACTION_OPEN_DOCUMENT_TREE with a persisted permission</li>
 *   <li>listFolder({uri}) -> {uri, name, entries: [{uri, name, size, mtime}]}: the pictures in a picked folder</li>
 *   <li>createInFolder({dirUri, name, mime, data}) -> {uri, name}: a new file in a picked folder (replaces a same-named file)</li>
 * </ul>
 */
@CapacitorPlugin(name = "QuillNative")
public class QuillNativePlugin extends Plugin {

    private static final String TAG = "QuillNative";
    private static final String EVENT_FILE_OPENED = "fileOpened";
    private static final String SHARE_DIR = "shared";
    private static final long SHARE_FILE_MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    /** Single background thread for file I/O so large documents never block the UI or the plugin queue. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Large payloads waiting for an activity result, kept out of the call's saved state. */
    private static final java.util.Map<String, String> pendingData = new java.util.concurrent.ConcurrentHashMap<>();
    /** Largest file read into memory (bytes); bigger files are refused instead of crashing. */
    private static final long MAX_READ_BYTES = 64L * 1024L * 1024L;

    private final Object launchLock = new Object();
    private boolean launchFileConsumed = false;

    @Override
    protected void handleOnDestroy() {
        io.shutdown();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // Clipboard
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                    ret.put("text", text != null ? text.toString() : JSObject.NULL);
                } else {
                    ret.put("text", JSObject.NULL);
                }
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) {
                    call.reject("No clipboard service");
                    return;
                }
                if ((text == null || text.isEmpty()) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cm.clearPrimaryClip();
                } else {
                    ClipData clip = ClipData.newPlainText("Anne's Lens", text);
                    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        PersistableBundle extras = new PersistableBundle();
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                        clip.getDescription().setExtras(extras);
                    }
                    cm.setPrimaryClip(clip);
                }
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not write the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Open / save via the Storage Access Framework
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimeTypes = toStringArray(call.getArray("mimeTypes"));
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (Boolean.TRUE.equals(call.getBoolean("multiple", false))) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
            startActivityForResult(call, intent, "openResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final List<Uri> uris = resultUris(result);
        if (uris.isEmpty()) {
            resolveCanceled(call);
            return;
        }
        for (Uri u : uris) {
            takePersistablePermission(u);
        }
        io.execute(() -> {
            try {
                if (uris.size() == 1) {
                    call.resolve(readDocument(uris.get(0), null));
                    return;
                }
                JSObject ret = new JSObject();
                JSArray files = new JSArray();
                for (Uri u : uris) {
                    files.put(readDocument(u, null));
                }
                ret.put("files", files);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = call.getString("name", "Untitled");
        String mime = call.getString("mime", "application/octet-stream");
        if (call.getString("data") == null) {
            call.reject("saveAs requires 'data'");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        // Capacitor parcels the call's data into onSaveInstanceState while the picker is up;
        // a large base64 document there exceeds the 1 MB binder limit (TransactionTooLargeException).
        pendingData.put(call.getCallbackId(), call.getString("data"));
        call.getData().remove("data");
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (ActivityNotFoundException e) {
            pendingData.remove(call.getCallbackId());
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        final String data = pendingData.remove(call.getCallbackId());
        if (uri == null) {
            resolveCanceled(call);
            return;
        }
        if (data == null) {
            // The app process was recreated while the picker was open.
            call.reject("The document was not kept while the file picker was open. Please save again.");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(uri, decodeBase64(data));
                takePersistablePermission(uri);
                String name = queryDisplayName(uri);
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", name != null ? name : call.getString("name", ""));
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not save document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeUri(PluginCall call) {
        final String uriString = call.getString("uri");
        final String data = call.getString("data");
        if (uriString == null || uriString.isEmpty() || data == null) {
            call.reject("writeUri requires 'uri' and 'data'");
            return;
        }
        io.execute(() -> {
            try {
                writeBytes(Uri.parse(uriString), decodeBase64(data));
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not write document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void readUri(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("readUri requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                call.resolve(readDocument(Uri.parse(uriString), null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // File operations (Storage Access Framework)
    // ---------------------------------------------------------------------------------------------

    private static final String[] PICTURE_EXTENSIONS = {
        "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "heic", "heif", "hif", "bmp", "dib", "ico", "cur", "tif", "tiff",
        "svg", "svgz", "jxl", "psd", "psb", "tga", "pnm", "ppm", "pgm", "pbm", "pam", "pfm", "qoi", "pcx", "dcx", "xpm", "xbm", "wbmp", "icns", "dds", "hdr",
        "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "dng", "3fr", "fff", "iiq", "x3f", "srw", "mrw", "erf", "mef", "mos", "kdc", "dcr"
    };

    private static boolean isPictureName(String name) {
        if (name == null) {
            return false;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0) {
            return false;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (String e : PICTURE_EXTENSIONS) {
            if (e.equals(ext)) {
                return true;
            }
        }
        return false;
    }

    @PluginMethod
    public void renameDocument(PluginCall call) {
        final String uriString = call.getString("uri");
        final String name = call.getString("name");
        if (uriString == null || uriString.isEmpty() || name == null || name.trim().isEmpty()) {
            call.reject("renameDocument requires 'uri' and 'name'");
            return;
        }
        io.execute(() -> {
            try {
                Uri uri = Uri.parse(uriString);
                Uri renamed = DocumentsContract.renameDocument(getContext().getContentResolver(), uri, name.trim());
                if (renamed == null) {
                    throw new IOException("The storage provider refused to rename the file");
                }
                takePersistablePermission(renamed);
                String newName = queryDisplayName(renamed);
                JSObject ret = new JSObject();
                ret.put("uri", renamed.toString());
                ret.put("name", newName != null ? newName : name.trim());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not rename: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void deleteDocument(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("deleteDocument requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                boolean ok = DocumentsContract.deleteDocument(getContext().getContentResolver(), Uri.parse(uriString));
                if (!ok) {
                    throw new IOException("The storage provider refused to delete the file");
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("trashed", false);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not delete: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "pickFolderResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No folder picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Uri tree = resultUri(result);
        if (tree == null) {
            resolveCanceled(call);
            return;
        }
        takePersistablePermission(tree);
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        String name = null;
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            name = queryDisplayName(docUri);
        } catch (Exception e) {
            Log.w(TAG, "Could not query the folder name", e);
        }
        if (name == null || name.isEmpty()) {
            String id = DocumentsContract.getTreeDocumentId(tree);
            int colon = id.lastIndexOf(':');
            int slash = id.lastIndexOf('/');
            name = id.substring(Math.max(colon, slash) + 1);
            if (name.isEmpty()) {
                name = "Folder";
            }
        }
        ret.put("name", name);
        call.resolve(ret);
    }

    @PluginMethod
    public void listFolder(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("listFolder requires 'uri'");
            return;
        }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(uriString);
                ContentResolver resolver = getContext().getContentResolver();
                String treeId = DocumentsContract.getTreeDocumentId(tree);
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeId);
                JSArray entries = new JSArray();
                String[] columns = {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                };
                try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                    while (cursor != null && cursor.moveToNext()) {
                        String id = cursor.getString(0);
                        String name = cursor.getString(1);
                        String mime = cursor.isNull(2) ? null : cursor.getString(2);
                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) || name == null || name.startsWith(".")) {
                            continue;
                        }
                        if (!isPictureName(name) && !(mime != null && mime.startsWith("image/"))) {
                            continue;
                        }
                        JSObject e = new JSObject();
                        e.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        e.put("name", name);
                        if (!cursor.isNull(3)) {
                            e.put("size", cursor.getLong(3));
                        }
                        if (!cursor.isNull(4)) {
                            e.put("mtime", cursor.getLong(4));
                        }
                        entries.put(e);
                    }
                }
                String folderName = queryDisplayName(DocumentsContract.buildDocumentUriUsingTree(tree, treeId));
                JSObject ret = new JSObject();
                ret.put("uri", tree.toString());
                ret.put("name", folderName != null ? folderName : "Folder");
                ret.put("entries", entries);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not list the folder: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void createInFolder(PluginCall call) {
        final String dirUri = call.getString("dirUri");
        final String name = call.getString("name");
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        if (dirUri == null || dirUri.isEmpty() || name == null || name.trim().isEmpty() || data == null) {
            call.reject("createInFolder requires 'dirUri', 'name' and 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(dirUri);
                ContentResolver resolver = getContext().getContentResolver();
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                // Replace a file of the same name rather than letting the provider append " (1)".
                Uri existing = findChild(resolver, tree, name.trim());
                if (existing != null) {
                    DocumentsContract.deleteDocument(resolver, existing);
                }
                Uri created = DocumentsContract.createDocument(resolver, parent, mime == null || mime.isEmpty() ? "application/octet-stream" : mime, name.trim());
                if (created == null) {
                    throw new IOException("The storage provider refused to create the file");
                }
                writeBytes(created, decodeBase64(data));
                String newName = queryDisplayName(created);
                JSObject ret = new JSObject();
                ret.put("uri", created.toString());
                ret.put("name", newName != null ? newName : name.trim());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not create the file: " + e.getMessage(), asException(e));
            }
        });
    }

    private static Uri findChild(ContentResolver resolver, Uri tree, String name) {
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
            try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                while (cursor != null && cursor.moveToNext()) {
                    if (name.equals(cursor.getString(1))) {
                        return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not look for " + name, e);
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // Print / share / screen
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void print(PluginCall call) {
        final String jobName = call.getString("jobName", "Anne's Lens document");
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Printing is not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                // The print UI asks the WebView to lay the page out again each time its preview
                // refreshes, so the page must keep its print content until the job is over: resolve
                // from onFinish (printed or cancelled), not as soon as the print UI opens.
                final PrintDocumentAdapter inner = webView.createPrintDocumentAdapter(jobName);
                PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                    private boolean done;

                    @Override
                    public void onStart() {
                        inner.onStart();
                    }

                    @Override
                    public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, android.os.CancellationSignal cancellationSignal, LayoutResultCallback callback, android.os.Bundle extras) {
                        inner.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
                    }

                    @Override
                    public void onWrite(android.print.PageRange[] pages, android.os.ParcelFileDescriptor destination, android.os.CancellationSignal cancellationSignal, WriteResultCallback callback) {
                        inner.onWrite(pages, destination, cancellationSignal, callback);
                    }

                    @Override
                    public void onFinish() {
                        try {
                            inner.onFinish();
                        } finally {
                            if (!done) {
                                done = true;
                                call.resolve();
                            }
                        }
                    }
                };
                printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
            } catch (Throwable e) {
                call.reject("Could not start printing: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        final String title = call.getString("title", name);
        if (data == null) {
            call.reject("share requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(decodeBase64(data));
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);

                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, name);
                send.setClipData(ClipData.newRawUri(name, uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Intent chooser = Intent.createChooser(send, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Sharing is not available right now");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        call.resolve();
                    } catch (ActivityNotFoundException e) {
                        call.reject("No app is available to share with", e);
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not share document: " + e.getMessage(), asException(e));
            }
        });
    }

    /** Sibling apps that may receive a document; any other package is refused. */
    private static final java.util.Set<String> SIBLING_APPS = new java.util.HashSet<>(java.util.Arrays.asList(
        "io.github.socrtwo.quillpen", "io.github.socrtwo.quillpost", "io.github.socrtwo.quilllens"));

    @PluginMethod
    public void openInApp(PluginCall call) {
        final String pkg = call.getString("packageName", "");
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        if (!SIBLING_APPS.contains(pkg)) {
            call.reject("openInApp only opens the Anne's Office apps");
            return;
        }
        if (data == null) {
            call.reject("openInApp requires 'data'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(decodeBase64(data));
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                final Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                view.setPackage(pkg);
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("The app is not in the foreground");
                    return;
                }
                activity.runOnUiThread(() -> {
                    JSObject ret = new JSObject();
                    try {
                        activity.startActivity(view);
                        ret.put("opened", true);
                    } catch (ActivityNotFoundException e) {
                        ret.put("opened", false);
                        ret.put("reason", "not-installed");
                    }
                    call.resolve(ret);
                });
            } catch (Throwable e) {
                call.reject("Could not open the document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.TRUE));
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity not available");
            return;
        }
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Files handed to us by other apps ("Open with" / "Share to")
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Intent launchIntent = null;
        synchronized (launchLock) {
            if (!launchFileConsumed) {
                launchFileConsumed = true;
                Activity activity = getActivity();
                launchIntent = activity != null ? activity.getIntent() : null;
            }
        }
        if (launchIntent == null || !isFileIntent(launchIntent)) {
            call.resolve(new JSObject());
            return;
        }
        final Intent intent = launchIntent;
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                call.resolve(file != null ? file : new JSObject());
            } catch (Throwable e) {
                call.reject("Could not read the launch file: " + e.getMessage(), asException(e));
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) {
            return;
        }
        // BridgeActivity replays the launching intent through onNewIntent() right after the bridge
        // starts. That one is delivered through getLaunchFile() instead, so skip it here.
        Activity activity = getActivity();
        if (activity != null && intent == activity.getIntent()) {
            return;
        }
        if (!isFileIntent(intent)) {
            return;
        }
        io.execute(() -> {
            try {
                JSObject file = readIntent(intent);
                if (file != null) {
                    // retainUntilConsumed: delivered later if the web app has not subscribed yet.
                    notifyListeners(EVENT_FILE_OPENED, file, true);
                }
            } catch (Exception e) {
                Log.e(TAG, "Could not read incoming file", e);
            }
        });
    }

    private static boolean isFileIntent(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            return intent.getData() != null;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return streamExtra(intent) != null || intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null;
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return !streamExtras(intent).isEmpty();
        }
        return false;
    }

    private JSObject readIntent(Intent intent) throws IOException {
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            List<Uri> uris = streamExtras(intent);
            if (uris.isEmpty()) {
                return null;
            }
            JSObject first = null;
            JSArray files = new JSArray();
            for (Uri u : uris) {
                takePersistablePermission(u);
                JSObject f = readDocument(u, intent.getType());
                if (first == null) {
                    first = f;
                }
                files.put(f);
            }
            first.put("files", files);
            return first;
        }
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamExtra(intent);
            if (uri == null) {
                // Plain text shared without a file: hand it over as a .txt file (opens as text import) (no uri).
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null) {
                    return null;
                }
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                String base = subject != null && !subject.trim().isEmpty() ? sanitizeFileName(subject.trim()) : "Shared text";
                JSObject ret = new JSObject();
                ret.put("name", base + ".txt");
                ret.put("mime", "text/plain");
                ret.put("data", Base64.encodeToString(text.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                return ret;
            }
        }
        if (uri == null) {
            return null;
        }
        takePersistablePermission(uri);
        return readDocument(uri, intent.getType());
    }

    private static List<Uri> streamExtras(Intent intent) {
        List<Uri> out = new ArrayList<>();
        ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (list != null) {
            for (Uri u : list) {
                if (u != null) {
                    out.add(u);
                }
            }
        }
        if (out.isEmpty()) {
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) {
                        out.add(u);
                    }
                }
            }
        }
        return out;
    }

    private static Uri streamExtra(Intent intent) {
        Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uri = clip.getItemAt(0).getUri();
            }
        }
        return uri;
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private JSObject readDocument(Uri uri, String hintMime) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] bytes;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) {
                throw new IOException("Unable to open " + uri);
            }
            bytes = readAll(in);
        }
        String name = queryDisplayName(uri);
        if (name == null || name.isEmpty()) {
            name = "Untitled";
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        ret.put("mime", resolveMime(resolver, uri, name, hintMime));
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return ret;
    }

    private void writeBytes(Uri uri, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream stream = null;
        try {
            // "wt" truncates; not every provider supports it, so fall back to "w".
            stream = resolver.openOutputStream(uri, "wt");
        } catch (Exception e) {
            Log.w(TAG, "openOutputStream(\"wt\") failed, retrying with \"w\": " + e.getMessage());
        }
        if (stream == null) {
            stream = resolver.openOutputStream(uri, "w");
        }
        if (stream == null) {
            throw new IOException("Unable to open " + uri + " for writing");
        }
        try (OutputStream out = stream) {
            out.write(bytes);
            out.flush();
        }
    }

    private String queryDisplayName(Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0 && !cursor.isNull(index)) {
                        String name = cursor.getString(index);
                        if (name != null && !name.isEmpty()) {
                            return name;
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not query display name for " + uri, e);
            }
        }
        String last = uri.getLastPathSegment();
        if (last == null) {
            return null;
        }
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    private static String resolveMime(ContentResolver resolver, Uri uri, String name, String hintMime) {
        String mime = null;
        try {
            mime = resolver.getType(uri);
        } catch (Exception ignored) {
            // Some providers throw for unknown URIs; fall through to the other strategies.
        }
        if (isSpecificMime(mime)) {
            return mime;
        }
        if (isSpecificMime(hintMime)) {
            return hintMime;
        }
        String fromExtension = mimeFromExtension(name);
        if (fromExtension != null) {
            return fromExtension;
        }
        return mime != null ? mime : "application/octet-stream";
    }

    private static boolean isSpecificMime(String mime) {
        return mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime) && !mime.contains("*");
    }

    private static String mimeFromExtension(String name) {
        if (name == null) {
            return null;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return null;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "jpg": case "jpeg": case "jpe": case "jfif": return "image/jpeg";
            case "png": case "apng": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "avif": return "image/avif";
            case "heic": case "heif": case "hif": return "image/heic";
            case "jxl": return "image/jxl";
            case "bmp": case "dib": return "image/bmp";
            case "ico": return "image/x-icon";
            case "cur": return "image/x-icon";
            case "tif": case "tiff": return "image/tiff";
            case "svg": case "svgz": return "image/svg+xml";
            case "psd": return "image/vnd.adobe.photoshop";
            case "tga": return "image/x-tga";
            case "pdf": return "application/pdf";
            case "txt": return "text/plain";
            case "zip": case "cbz": return "application/zip";
            default:
                return null;
        }
    }

    private void takePersistablePermission(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (Exception e) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Not a persistable grant (e.g. a one-off VIEW intent); access lasts for this session.
            }
        }
    }

    private static Uri resultUri(ActivityResult result) {
        List<Uri> uris = resultUris(result);
        return uris.isEmpty() ? null : uris.get(0);
    }

    /** Every URI an activity result carries (one, or several when EXTRA_ALLOW_MULTIPLE was set). */
    private static List<Uri> resultUris(ActivityResult result) {
        List<Uri> out = new ArrayList<>();
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            return out;
        }
        Intent data = result.getData();
        if (data == null) {
            return out;
        }
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) {
                    out.add(u);
                }
            }
        }
        if (out.isEmpty() && data.getData() != null) {
            out.add(data.getData());
        }
        return out;
    }

    private static Exception asException(Throwable t) {
        return t instanceof Exception ? (Exception) t : new Exception(t.toString(), t);
    }

    private static void resolveCanceled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("canceled", true);
        call.resolve(ret);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buffer = new byte[64 * 1024];
        int read;
        long total = 0;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_READ_BYTES) {
                throw new IOException("File is larger than " + (MAX_READ_BYTES / (1024 * 1024)) + " MB");
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static byte[] decodeBase64(String data) {
        if (data == null) {
            return new byte[0];
        }
        // Tolerate a data: URL prefix ("data:<mime>;base64,....").
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        String payload = comma >= 0 ? data.substring(comma + 1) : data;
        return Base64.decode(payload, Base64.DEFAULT);
    }

    private static String[] toStringArray(JSArray array) {
        List<String> out = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                Object value = array.opt(i);
                if (value instanceof String && !((String) value).isEmpty()) {
                    out.add((String) value);
                }
            }
        }
        return out.toArray(new String[0]);
    }

    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "picture";
        }
        return cleaned;
    }

    private static void pruneOldShares(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - SHARE_FILE_MAX_AGE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff && !f.delete()) {
                Log.w(TAG, "Could not delete old shared file " + f.getName());
            }
        }
    }
}
