package com.nexusroom.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Small non-streaming adapter for the two OpenAI tool calling protocols. */
final class AgentModelClient implements AutoCloseable {
    static final class ToolCall {
        final String id, name;
        final JSONObject arguments;
        ToolCall(String id,String name,JSONObject arguments) {this.id=id;this.name=name;this.arguments=arguments;}
    }
    static final class Reply {
        final String text;
        final List<ToolCall> calls;
        final JSONObject chatMessage;
        final JSONArray responseOutput;
        Reply(String text,List<ToolCall> calls,JSONObject chatMessage,JSONArray responseOutput) {
            this.text=text;this.calls=calls;this.chatMessage=chatMessage;this.responseOutput=responseOutput;
        }
    }
    private final OkHttpClient client=new OkHttpClient.Builder().connectTimeout(12,TimeUnit.SECONDS)
        .writeTimeout(20,TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();
    private final String endpoint,apiKey,model,apiType;
    private volatile Call active;
    AgentModelClient(JSONObject plan)throws Exception {
        apiType=plan.optString("apiType",plan.optString("interface","chat_completions")).toLowerCase(java.util.Locale.ROOT);
        if(!apiType.equals("responses")&&!apiType.equals("chat_completions")&&!apiType.equals("chat"))throw new Exception("模型接口只支持 Responses 或 Chat Completions");
        apiKey=plan.optString("apiKey","").trim();model=plan.optString("model","").trim();
        if(apiKey.isEmpty()||model.isEmpty()||apiKey.length()>4096||model.length()>200)throw new Exception("模型方案缺少有效的 API Key 或模型名");
        String url=plan.optString("apiUrl",plan.optString("baseUrl",plan.optString("url",plan.optString("endpoint","")))).trim();
        URI uri=new URI(url);
        if(!"https".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getFragment()!=null)
            throw new Exception("模型 API 地址必须是 HTTPS，且不能包含账号或片段");
        String path=uri.getPath()==null?"":uri.getPath().replaceAll("/+$","");
        if(path.endsWith("/chat/completions"))path=path.substring(0,path.length()-"/chat/completions".length());
        if(path.endsWith("/responses"))path=path.substring(0,path.length()-"/responses".length());
        if(!path.matches("(?i).*/v[0-9]+"))path+="/v1";
        String suffix=responses()?"/responses":"/chat/completions";
        endpoint=new URI(uri.getScheme(),null,uri.getHost(),uri.getPort(),path+suffix,null,null).toASCIIString();
    }
    boolean responses(){return apiType.equals("responses");}
    void cancel(){Call call=active;if(call!=null)call.cancel();}
    @Override public void close(){cancel();client.dispatcher().executorService().shutdown();client.connectionPool().evictAll();}
    Reply complete(JSONArray history,String instructions,long timeoutMillis)throws Exception {
        if(timeoutMillis<=0)throw new java.util.concurrent.TimeoutException("Timeout: Agent 任务执行时限已到");
        JSONObject payload=new JSONObject().put("model",model).put("tools",AgentTools.definitions(responses()))
            .put("parallel_tool_calls",false);
        if(responses())payload.put("instructions",instructions).put("input",history).put("max_output_tokens",1600).put("store",false);
        else payload.put("messages",history).put("tool_choice","auto").put("max_completion_tokens",1600);
        Request request=new Request.Builder().url(endpoint).header("Authorization","Bearer "+apiKey)
            .header("Accept","application/json")
            .post(RequestBody.create(payload.toString(),MediaType.get("application/json; charset=utf-8"))).build();
        OkHttpClient requestClient=client.newBuilder()
            .readTimeout(timeoutMillis,TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMillis,TimeUnit.MILLISECONDS)
            .build();
        Call call=requestClient.newCall(request);active=call;
        try(Response response=call.execute()) {
            if(response.body()==null)throw new Exception("模型未返回内容");
            String raw=response.body().string();
            if(raw.length()>1024*1024)throw new Exception("模型响应过大");
            if(!response.isSuccessful()) {
                String message="";
                try{message=new JSONObject(raw).optJSONObject("error").optString("message","");}catch(Exception ignored){}
                throw new Exception("模型 API HTTP "+response.code()+": "+shortError(message));
            }
            JSONObject root=new JSONObject(raw);
            return responses()?responseReply(root):chatReply(root);
        } finally {active=null;}
    }
    private String shortError(String value){String clean=value.replace(apiKey,"[redacted]");return clean.length()>240?clean.substring(0,240):clean;}
    private static Reply chatReply(JSONObject root)throws Exception {
        JSONArray choices=root.optJSONArray("choices");if(choices==null||choices.length()==0)throw new Exception("Chat Completions 没有 choices");
        JSONObject choice=choices.getJSONObject(0),message=choice.optJSONObject("message");if(message==null)throw new Exception("Chat Completions 缺少 message");
        if("length".equals(choice.optString("finish_reason")))throw new Exception("模型达到单轮输出上限");
        List<ToolCall> calls=new ArrayList<>();JSONArray rawCalls=message.optJSONArray("tool_calls");
        if(rawCalls!=null)for(int i=0;i<rawCalls.length();i++) {
            JSONObject item=rawCalls.getJSONObject(i),function=item.optJSONObject("function");
            if(function==null)throw new Exception("模型工具调用缺少 function");
            calls.add(new ToolCall(item.getString("id"),function.getString("name"),parseArguments(function.optString("arguments","{}"))));
        }
        return new Reply(message.optString("content",""),calls,message,null);
    }
    private static Reply responseReply(JSONObject root)throws Exception {
        JSONArray output=root.optJSONArray("output");if(output==null)throw new Exception("Responses API 缺少 output");
        if("incomplete".equals(root.optString("status")))throw new Exception("模型输出未完成，请提高单轮输出额度");
        StringBuilder text=new StringBuilder();List<ToolCall> calls=new ArrayList<>();
        for(int i=0;i<output.length();i++) {
            JSONObject item=output.optJSONObject(i);if(item==null)continue;
            if("function_call".equals(item.optString("type")))calls.add(new ToolCall(item.getString("call_id"),item.getString("name"),parseArguments(item.optString("arguments","{}"))));
            if("message".equals(item.optString("type"))) {
                JSONArray content=item.optJSONArray("content");if(content!=null)for(int j=0;j<content.length();j++) {
                    JSONObject part=content.optJSONObject(j);
                    if(part!=null&&"output_text".equals(part.optString("type")))text.append(part.optString("text"));
                }
            }
        }
        return new Reply(text.toString(),calls,null,output);
    }
    private static JSONObject parseArguments(String value)throws Exception {
        if(value.length()>32000)throw new Exception("模型工具参数过长");
        try{return new JSONObject(value);}catch(Exception e){throw new Exception("模型返回了无效的工具参数 JSON");}
    }
}
