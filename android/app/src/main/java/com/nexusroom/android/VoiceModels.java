package com.nexusroom.android;

import android.content.res.AssetManager;
import com.k2fsa.sherpa.onnx.*;

/** Native model construction is confined here; neither audio nor models leave the device. */
final class VoiceModels {
    private VoiceModels(){}
    static OnlineModelConfig model(String root,String encoder,String decoder,String joiner,int threads){
        OnlineTransducerModelConfig transducer=new OnlineTransducerModelConfig();
        transducer.setEncoder(root+encoder);transducer.setDecoder(root+decoder);transducer.setJoiner(root+joiner);
        OnlineModelConfig config=new OnlineModelConfig();config.setTransducer(transducer);config.setTokens(root+"tokens.txt");
        config.setNumThreads(threads);config.setProvider("cpu");return config;
    }
    static KeywordSpotter kws(AssetManager assets){
        KeywordSpotterConfig config=new KeywordSpotterConfig();
        config.setModelConfig(model("voice/kws/","encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx","decoder-epoch-13-avg-2-chunk-16-left-64.onnx","joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",1));
        config.setKeywordsFile("voice/keywords.txt");config.setKeywordsThreshold(.30f);
        return new KeywordSpotter(assets,config);
    }
    static OnlineRecognizer asr(AssetManager assets){
        OnlineRecognizerConfig config=new OnlineRecognizerConfig();
        config.setModelConfig(model("voice/asr/","encoder-epoch-99-avg-1.int8.onnx","decoder-epoch-99-avg-1.onnx","joiner-epoch-99-avg-1.int8.onnx",2));
        EndpointConfig endpoint=new EndpointConfig();endpoint.setRule1(new EndpointRule(false,7f,0f));endpoint.setRule2(new EndpointRule(true,1.1f,0f));endpoint.setRule3(new EndpointRule(false,0f,25f));
        config.setEndpointConfig(endpoint);config.setEnableEndpoint(true);return new OnlineRecognizer(assets,config);
    }
}
