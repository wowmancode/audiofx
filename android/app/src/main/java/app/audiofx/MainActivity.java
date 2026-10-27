package app.audiofx;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Hosts the AudioFX web app in a WebView. The web files are bundled in the
 * APK and served from a virtual https origin, which gives the page a secure
 * context (needed for the microphone and AudioWorklet) without any network.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";
    private static final int REQ_MIC = 1;
    private static final int REQ_FILE = 2;

    private WebView web;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(0xFF0F1115);
        window.setNavigationBarColor(0xFF0F1115);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.PathHandler() {
                    @Override
                    public WebResourceResponse handle(String path) {
                        if (path.isEmpty() || path.endsWith("/")) {
                            path = path + "index.html";
                        }
                        try {
                            InputStream in = getAssets().open(path);
                            return new WebResourceResponse(mimeFor(path), "utf-8", in);
                        } catch (IOException e) {
                            return null;
                        }
                    }
                })
                .build();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Bridge(), "AudioFXNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (HOST.equals(request.getUrl().getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) {
                    // No browser installed; nothing to do.
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        boolean wantsMic = false;
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                                wantsMic = true;
                            }
                        }
                        if (!wantsMic) {
                            request.deny();
                            return;
                        }
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                                == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        } else {
                            pendingMic = request;
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("audio/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose an audio file"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC || pendingMic == null) {
            return;
        }
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) {
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** Lets the page save recordings, since a WebView cannot download blob: links. */
    private class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String mime, String base64) {
            try {
                String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AudioFX");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) {
                        return "";
                    }
                    OutputStream out = getContentResolver().openOutputStream(uri);
                    if (out == null) {
                        return "";
                    }
                    try {
                        out.write(data);
                    } finally {
                        out.close();
                    }
                    return "Downloads/AudioFX/" + safe;
                }
                File dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                if (dir == null) {
                    return "";
                }
                dir.mkdirs();
                File file = new File(dir, safe);
                FileOutputStream out = new FileOutputStream(file);
                try {
                    out.write(data);
                } finally {
                    out.close();
                }
                return file.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }
    }
}
