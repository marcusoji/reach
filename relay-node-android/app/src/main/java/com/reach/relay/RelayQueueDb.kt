package com.reach.relay

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class RelayQueueDb(context:Context):SQLiteOpenHelper(context,"reach-relay.db",null,1){
    override fun onCreate(db:SQLiteDatabase){db.execSQL("CREATE TABLE relay_queue(id TEXT PRIMARY KEY, packet TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL)")}
    override fun onUpgrade(db:SQLiteDatabase,oldVersion:Int,newVersion:Int){}
    @Synchronized fun enqueue(packet:JSONObject){writableDatabase.execSQL("INSERT OR IGNORE INTO relay_queue(id,packet,attempts,next_at,created_at) VALUES(?,?,?,?,?)",arrayOf(packet.optString("k"),packet.toString(),0,System.currentTimeMillis(),System.currentTimeMillis()))}
    @Synchronized fun due(limit:Int=20):List<Pair<String,JSONObject>>{val out=mutableListOf<Pair<String,JSONObject>>();readableDatabase.rawQuery("SELECT id,packet FROM relay_queue WHERE next_at<=? ORDER BY created_at LIMIT ?",arrayOf(System.currentTimeMillis().toString(),limit.toString())).use{c->while(c.moveToNext())out += c.getString(0) to JSONObject(c.getString(1))};return out}
    @Synchronized fun success(id:String){writableDatabase.delete("relay_queue","id=?",arrayOf(id))}
    @Synchronized fun retry(id:String,attempts:Int){val delay=(1000L shl attempts.coerceAtMost(6)).coerceAtMost(120000L);writableDatabase.execSQL("UPDATE relay_queue SET attempts=?,next_at=? WHERE id=?",arrayOf(attempts+1,System.currentTimeMillis()+delay,id))}
}
