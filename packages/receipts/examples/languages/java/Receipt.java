// The smallest possible client, JDK only (java.net.http; run as a single-file program with `java Receipt.java`).
// JSON is hand-built and read with regexes to keep the example dependency-free; a real application uses Jackson or Gson.
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Receipt {
    static final HttpClient http = HttpClient.newHttpClient();
    static String url = System.getenv().getOrDefault("SIDECAR_URL", "http://127.0.0.1:8788/");

    static String post(String path, String json) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(url + path)).header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json)).build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) throw new RuntimeException(path + ": " + res.statusCode() + " " + res.body());
        return res.body();
    }

    public static void main(String[] args) throws Exception {
        String event = "{\"tool\":\"stripe.refund\",\"args\":{\"amount\":500},\"session\":{\"id\":\"java-run\",\"toolUseId\":\"call-1\"}}";
        String policy = post("decide", event);
        if (policy.contains("\"decision\":\"deny\"")) {
            post("record", "{\"event\":" + event + ",\"outcome\":{\"status\":\"denied\",\"reason\":\"policy\"},\"policy\":" + policy + "}");
            System.out.println("denied");
            System.exit(1);
        }
        String result = "{\"refund_id\":\"re_java\",\"amount\":500}"; // the tool ran here
        String bundle = post("record", "{\"event\":" + event + ",\"outcome\":{\"status\":\"executed\",\"result\":" + result + "},\"policy\":" + ("null".equals(policy) ? "null" : policy) + "}");
        Matcher m = Pattern.compile("\"treeSize\":(\\d+)").matcher(bundle);
        if (!m.find()) throw new RuntimeException("no inclusion proof in the bundle");
        System.out.println("java: receipt at tree size " + m.group(1));
        System.out.println("OK");
    }
}
